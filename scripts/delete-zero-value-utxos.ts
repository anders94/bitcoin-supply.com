// One-time cleanup: remove zero-value outputs from the utxos table.
//
// WHY: a zero-value output holds no supply, so it can never be lost supply.
// The Proposal 004 classifier omitted the "positive value" test its own text
// requires, so ~238M zero-value OP_RETURN data carriers (59% of the table)
// were stored and counted as provably lost. They each contribute 0 sats, so
// no BTC total changes here — only counts. Bitcoin Core likewise never puts
// OP_RETURN outputs in the UTXO set.
//
// SAFETY:
//   * Dry run by default. Pass --execute to actually delete.
//   * Batched by block_number (the partition key) so each statement is a small
//     transaction — never one 238M-row lock. NOTE: do not batch on ctid; it is
//     not unique across partitions and would delete the wrong rows.
//   * The main pass carries "loss_bucket IN (1,2)" purely so the planner can use
//     the partial index (block_number DESC, value_sats DESC) WHERE loss_bucket
//     IN (1,2). Without it every batch is a parallel seq scan of an ~80-250M row
//     partition (cost ~9.7M vs ~25k — a 391x difference). >99.99% of zero-value
//     rows are bucket 1; the handful in buckets 0/4 are swept in a final pass.
//   * Resumable: progress is derived from the data itself (the lowest block
//     still holding a zero-value row), so an interrupted run just picks up.
//   * Addresses touched by the delete are captured to a durable table BEFORE
//     any row is removed, since they can't be found afterwards.
//
// Deploy the ETL fix (block-processor skips zero-value outputs) BEFORE running
// this, or live sync will keep inserting new ones behind you.
//
// Usage:
//   npx tsx scripts/delete-zero-value-utxos.ts              # dry run
//   npx tsx scripts/delete-zero-value-utxos.ts --execute
//
// Afterwards, recompute the aggregates:
//   node dist/etl/index.js snapshot

import 'dotenv/config';
import { pool } from '../src/db/index.js';

const EXECUTE = process.argv.includes('--execute');

// Target rows per batch. The window auto-tunes toward this: zero-value rows
// run ~1,500/block in the Ordinals era but ~0/block before block 360,000.
const TARGET_BATCH = 25_000;
const MIN_WINDOW = 1;
const MAX_WINDOW = 100_000;

const ADDR_TABLE = 'zero_value_cleanup_addresses';

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

async function main() {
  const started = Date.now();

  // ---- Survey ------------------------------------------------------------
  const { rows: [survey] } = await pool.query(`
    SELECT COUNT(*) AS zero_rows,
           COUNT(*) FILTER (WHERE address IS NOT NULL) AS with_address,
           COALESCE(SUM(value_sats), 0) AS total_sats,
           MIN(block_number) AS min_blk,
           MAX(block_number) AS max_blk
    FROM utxos WHERE value_sats = 0
  `);
  const zeroRows = Number(survey.zero_rows);

  console.log('zero-value rows      :', fmt(zeroRows));
  console.log('  ...carrying an addr:', fmt(Number(survey.with_address)));
  console.log('  ...total value      :', survey.total_sats, 'sats');
  console.log('  ...block range      :', survey.min_blk, '→', survey.max_blk);

  if (zeroRows === 0) {
    console.log('\nNothing to do — no zero-value rows remain.');
    await pool.end();
    return;
  }

  // The whole premise: these rows sum to zero, so no BTC total can move.
  // If that is ever false, stop — something is wrong with our understanding.
  if (BigInt(survey.total_sats) !== 0n) {
    throw new Error(`refusing to run: zero-value rows sum to ${survey.total_sats}, expected 0`);
  }

  if (!EXECUTE) {
    const { rows: preview } = await pool.query(`
      SELECT loss_bucket, COUNT(*) AS rows FROM utxos WHERE value_sats = 0
      GROUP BY 1 ORDER BY 1
    `);
    console.log('\nrows to delete, by bucket (0=active 1=provable 2=probable 4=quantum):');
    for (const r of preview) console.log(`  bucket ${r.loss_bucket}: ${fmt(Number(r.rows))}`);
    console.log('\nDRY RUN — nothing deleted. Re-run with --execute to apply.');
    await pool.end();
    return;
  }

  // ---- Capture affected addresses (must happen before any delete) ---------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${ADDR_TABLE} (
      address TEXT PRIMARY KEY,
      reconciled BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  const captured = await pool.query(`
    INSERT INTO ${ADDR_TABLE} (address)
    SELECT DISTINCT address FROM utxos WHERE value_sats = 0 AND address IS NOT NULL
    ON CONFLICT (address) DO NOTHING
  `);
  const { rows: [{ n: addrTotal }] } = await pool.query(`SELECT COUNT(*) AS n FROM ${ADDR_TABLE}`);
  console.log(`\ncaptured ${fmt(captured.rowCount ?? 0)} new address(es) for reconcile ` +
              `(${fmt(Number(addrTotal))} tracked total)`);

  // ---- Batched delete ----------------------------------------------------
  const tip = Number(survey.max_blk);
  let from = Number(survey.min_blk);   // resumes here automatically on re-run
  let window = 1_000;
  let deleted = 0;
  let batches = 0;

  console.log(`\ndeleting from block ${fmt(from)} to ${fmt(tip)}…`);

  // INDEXED is what makes this tractable — see the header note. Keep it on both
  // the probe and the delete so they agree on which rows a window holds.
  const INDEXED = 'value_sats = 0 AND loss_bucket IN (1, 2)';

  const countRange = async (lo: number, hi: number): Promise<number> => {
    const { rows: [r] } = await pool.query(
      `SELECT COUNT(*) AS n FROM utxos WHERE block_number >= $1 AND block_number < $2 AND ${INDEXED}`,
      [lo, hi]
    );
    return Number(r.n);
  };

  while (from <= tip) {
    // Probe before deleting. Density swings from ~0 rows/block before block
    // 360,000 to ~1,500/block in the Ordinals era, so a window tuned for the
    // sparse chain would delete millions of rows in one statement on arrival.
    // Shrink until the batch is bounded, THEN delete.
    let to = Math.min(from + window, tip + 1);
    let n = await countRange(from, to);
    while (n > TARGET_BATCH * 2 && to - from > 1) {
      to = from + Math.max(1, Math.floor((to - from) / 4));
      n = await countRange(from, to);
    }

    if (n > 0) {
      const res = await pool.query(
        `DELETE FROM utxos WHERE block_number >= $1 AND block_number < $2 AND ${INDEXED}`,
        [from, to]
      );
      deleted += res.rowCount ?? 0;
    }
    batches++;

    const pct = ((deleted / zeroRows) * 100).toFixed(1);
    process.stdout.write(
      `\r  block ${fmt(from)}/${fmt(tip)} · deleted ${fmt(deleted)} (${pct}%) · window ${fmt(to - from)}    `
    );

    // Re-tune for the next window.
    if (n > TARGET_BATCH) window = Math.max(MIN_WINDOW, Math.floor((to - from) / 2));
    else if (n < TARGET_BATCH / 4) window = Math.min(MAX_WINDOW, Math.max((to - from) * 2, 1));

    from = to;
  }
  console.log(`\n\nmain pass: deleted ${fmt(deleted)} rows in ${fmt(batches)} batches`);

  // ---- Sweep the stragglers ---------------------------------------------
  // Zero-value rows outside buckets 1/2 (~15k: bucket 0 spendable dust and a
  // couple of quantum-tagged). Too few to index for; one pass handles them.
  // VACUUM first so the value_sats index isn't clogged with the dead entries
  // the main pass just made — otherwise this scan crawls through all of them.
  console.log('vacuuming utxos before the straggler sweep (takes a while)…');
  await pool.query('VACUUM ANALYZE utxos');

  const sweep = await pool.query('DELETE FROM utxos WHERE value_sats = 0');
  console.log(`straggler sweep: deleted ${fmt(sweep.rowCount ?? 0)} rows`);
  deleted += sweep.rowCount ?? 0;
  console.log(`total deleted: ${fmt(deleted)} rows`);

  // ---- Reconcile address_info -------------------------------------------
  // utxo_value_sats is unaffected (the rows summed to 0), but utxo_count
  // counted them. Recompute both from the surviving rows to be certain.
  const rec = await pool.query(`
    UPDATE address_info ai
    SET utxo_count = c.n,
        utxo_value_sats = c.v,
        updated_at = now()
    FROM (
      SELECT a.address,
             COUNT(u.tx_hash) AS n,
             COALESCE(SUM(u.value_sats), 0) AS v
      FROM ${ADDR_TABLE} a
      LEFT JOIN utxos u ON u.address = a.address
      WHERE a.reconciled = FALSE
      GROUP BY a.address
    ) c
    WHERE ai.address = c.address
  `);
  await pool.query(`UPDATE ${ADDR_TABLE} SET reconciled = TRUE WHERE reconciled = FALSE`);
  console.log(`reconciled ${fmt(rec.rowCount ?? 0)} address_info row(s)`);

  // Stats are refreshed by the VACUUM ANALYZE above, but the straggler sweep
  // and the reconcile ran after it; the table lost ~59% of its rows, and stale
  // stats would wreck query plans across the site.
  console.log('running final ANALYZE on utxos…');
  await pool.query('ANALYZE utxos');

  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\ndone in ${mins} min.`);
  console.log('Next: node dist/etl/index.js snapshot   # recompute aggregates');
  console.log('Disk space is reclaimed for reuse by autovacuum; a VACUUM FULL');
  console.log('during a maintenance window would return it to the filesystem.');

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
