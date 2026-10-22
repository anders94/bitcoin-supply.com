// One-off backfill for the quantum-exposure rules added 2026-10-13 (see
// docs/quantum-exposure-plan.md). New blocks are handled by the ETL; this
// brings everything already indexed up to the same rules.
//
// Phases (comma-separated via --phase; default runs the SQL-only ones):
//
//   fix       Clear the exposed flag on lost rows (buckets 1 / 2). The old ETL
//             flagged every P2PK-shaped script, including off-curve keys that
//             have no private key to derive and NUMS keys (018), which the
//             quantum lens leaves out by convention.
//   kinds     Fill address_info.exposure_kind for rows written before
//             migration 008 (p2pk if is_p2pk, else pkh). Optional and NOT in
//             the default set: every reader already falls back to exactly
//             this, and it rewrites ~1.3B rows of a 500 GB table in one
//             statement (hours, heavy bloat, row locks the live ETL waits on).
//   receipts  Flag UTXOs received at an address *after* its key was revealed
//             (016 / 021). The largest single correction, ~2.3M BTC.
//   p2tr      Proposal 019: every on-curve taproot output, plus address_info.
//   p2ms      Proposal 020: bare multisig with >= M on-curve keys.
//   scripts   Proposal 021: keys revealed by historical P2SH / P2WSH spends.
//             The database keeps no spent inputs, so this walks the chain over
//             RPC. Every not-yet-exposed address is marked, empty or not: an
//             address that is empty today and refilled later must already be
//             known as exposed, or the ETL cannot flag the receipt. Resumable:
//             progress is kept in etl_state under 'backfill_021_next_block'.
//             Run it on the ETL box.
//
// Usage:
//   npx tsx scripts/backfill-quantum-exposure.ts                      # dry run, SQL phases
//   npx tsx scripts/backfill-quantum-exposure.ts --execute
//   npx tsx scripts/backfill-quantum-exposure.ts --phase scripts --execute [--from N] [--to N]
//
// Every phase is idempotent and safe to re-run; the live ETL may keep running
// alongside (both sides only ever set flags that are not yet set).
//
// Afterwards run `npm run snapshot` (or wait for the hourly job): every quantum
// figure on the site comes from loss_snapshots / computed_stats.

import 'dotenv/config';
import { pool } from '../src/db/index.js';
import { config } from '../src/config.js';
import { getBlockHash, getBlock } from '../src/services/bitcoin-rpc.js';
import { exposedKeysInOutput, revealedKeysFromInput, exposureRule, Exposure } from '../src/classifiers/exposure.js';
import { markAddressPubkeyExposed as markAddr } from '../src/db/address-info.js';
import { markAddressPubkeyExposed as markUtxos } from '../src/db/utxos.js';

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const argValue = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const PHASES = (argValue('--phase') ?? 'fix,receipts,p2tr,p2ms').split(',').map(s => s.trim());

// utxos is partitioned by halving epoch; one statement per partition keeps
// each transaction (and its WAL) bounded.
const EPOCHS: [number, number][] = [
  [0, 210_000], [210_000, 420_000], [420_000, 630_000], [630_000, 840_000], [840_000, 1_050_000],
];

const btc = (sats: bigint | string | number) => (Number(sats) / 1e8).toFixed(8);
const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

const TAPROOT_ACTIVATION = 709_632;
const P2TR_BATCH_PAGES = 50_000;   // ~400 MB of heap per transaction
const ADDRESS_BATCH = 20_000;

// The live ETL updates the same rows in its own order, so a write here can
// lose a deadlock (40P01). Postgres rolls back only the losing statement;
// retrying it is safe because every write in this script is idempotent.
async function withDeadlockRetry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (err?.code !== '40P01' || i >= attempts) throw err;
      log(`  deadlock with a concurrent writer, retrying (${i}/${attempts - 1})`);
      await new Promise(r => setTimeout(r, 1000 * i));
    }
  }
}

// ---------------------------------------------------------------------------
// fix: off-curve P2PK rows carry no breakable key
// ---------------------------------------------------------------------------
async function phaseFix(): Promise<void> {
  log('phase fix: lost rows (buckets 1 / 2) flagged exposed');
  const { rows } = await pool.query(`
    SELECT COUNT(*)::text AS n, COALESCE(SUM(value_sats), 0)::text AS sats
    FROM utxos WHERE loss_bucket IN (1, 2) AND pubkey_exposed = TRUE
  `);
  log(`  ${rows[0].n} rows, ${btc(rows[0].sats)} BTC`);
  if (!EXECUTE) return;
  for (const [lo, hi] of EPOCHS) {
    const res = await pool.query(`
      UPDATE utxos SET pubkey_exposed = FALSE, pubkey_hex = NULL
      WHERE loss_bucket IN (1, 2) AND pubkey_exposed = TRUE AND block_number >= $1 AND block_number < $2
    `, [lo, hi]);
    log(`  epoch ${lo}-${hi}: cleared ${res.rowCount}`);
  }
}

// ---------------------------------------------------------------------------
// kinds: legacy address_info rows
// ---------------------------------------------------------------------------
async function phaseKinds(): Promise<void> {
  log('phase kinds: exposure_kind for pre-008 address_info rows');
  const { rows } = await pool.query(`
    SELECT COUNT(*)::text AS n FROM address_info WHERE pubkey_exposed = TRUE AND exposure_kind IS NULL
  `);
  log(`  ${rows[0].n} rows without a kind`);
  if (!EXECUTE) return;
  const res = await pool.query(`
    UPDATE address_info
    SET exposure_kind = CASE WHEN is_p2pk THEN 'p2pk' ELSE 'pkh' END
    WHERE pubkey_exposed = TRUE AND exposure_kind IS NULL
  `);
  log(`  set ${res.rowCount}`);
}

// ---------------------------------------------------------------------------
// receipts: coins that arrived after the address's key was already public
// ---------------------------------------------------------------------------
async function phaseReceipts(): Promise<void> {
  log('phase receipts: unflagged UTXOs at exposed addresses');
  // address_info is ~1.5B rows / 500 GB, so it is scanned exactly once: the
  // exposed addresses that still have unflagged UTXOs go into a temp table,
  // and each partition's UPDATE joins against that instead. Temp tables are
  // per-session, hence one dedicated client. Anything exposed or received
  // after the snapshot is taken is the live ETL's to flag.
  const client = await pool.connect();
  try {
    // Materialised first so the planner sees the real address count: its
    // n_distinct estimate for utxos.address is ~100x low, which makes it pick
    // tens of millions of index probes into address_info over one scan.
    log('  collecting addresses with unflagged UTXOs');
    await client.query(`
      CREATE TEMP TABLE receipt_candidates AS
      SELECT DISTINCT address FROM utxos
      WHERE NOT pubkey_exposed AND loss_bucket IN (0, 4) AND address IS NOT NULL
    `);
    await client.query('ANALYZE receipt_candidates');

    log('  matching against exposed addresses (one address_info scan)');
    await client.query('SET enable_nestloop = off');
    await client.query(`
      CREATE TEMP TABLE receipt_targets AS
      SELECT ai.address, ai.pubkey_hex,
             CASE WHEN ai.exposure_kind IN ('script', 'script-mixed') THEN '021' ELSE '016' END AS rule
      FROM address_info ai JOIN receipt_candidates c ON c.address = ai.address
      WHERE ai.pubkey_exposed
    `);
    await client.query('RESET enable_nestloop');
    await client.query('DROP TABLE receipt_candidates');
    await client.query('CREATE UNIQUE INDEX ON receipt_targets (address)');
    await client.query('ANALYZE receipt_targets');

    const { rows } = await client.query(`
      SELECT (SELECT COUNT(*) FROM receipt_targets)::text AS addrs,
             COUNT(*)::text AS n, COALESCE(SUM(u.value_sats), 0)::text AS sats
      FROM utxos u JOIN receipt_targets t ON t.address = u.address
      WHERE NOT u.pubkey_exposed AND u.loss_bucket IN (0, 4)
    `);
    log(`  ${rows[0].addrs} addresses, ${rows[0].n} rows, ${btc(rows[0].sats)} BTC`);
    if (!EXECUTE) return;

    for (const [lo, hi] of EPOCHS) {
      const res = await client.query(`
        UPDATE utxos u
        SET pubkey_exposed = TRUE,
            pubkey_hex = COALESCE(t.pubkey_hex, u.pubkey_hex),
            loss_rules = CASE
              WHEN u.loss_bucket = 0 AND NOT u.loss_rules @> ARRAY[t.rule] THEN array_append(u.loss_rules, t.rule)
              ELSE u.loss_rules END
        FROM receipt_targets t
        WHERE t.address = u.address
          AND NOT u.pubkey_exposed AND u.loss_bucket IN (0, 4)
          AND u.block_number >= $1 AND u.block_number < $2
      `, [lo, hi]);
      log(`  epoch ${lo}-${hi}: flagged ${res.rowCount}`);
    }
  } finally {
    await client.query('DROP TABLE IF EXISTS receipt_candidates, receipt_targets').catch(() => {});
    client.release();
  }
}

// ---------------------------------------------------------------------------
// p2tr: Proposal 019
// ---------------------------------------------------------------------------
async function phaseP2tr(): Promise<void> {
  log('phase p2tr: taproot outputs (019)');
  const { rows } = await pool.query(`
    SELECT COUNT(*)::text AS n, COALESCE(SUM(value_sats), 0)::text AS sats
    FROM utxos WHERE script_type = 'witness_v1_taproot' AND loss_bucket <> 1 AND NOT loss_rules @> '{019}'
  `);
  log(`  ${rows[0].n} rows, ${btc(rows[0].sats)} BTC`);
  if (!EXECUTE) return;

  // Short transactions: a single UPDATE over a whole partition deadlocks with
  // the live ETL, which touches the same rows in its own order. Batches are
  // physical page ranges (TID range scan), so the partition is still read only
  // once in total; block_number has no index usable for bucket-0 rows, so
  // block ranges would seq-scan the partition per batch. A batch that loses a
  // deadlock is retried. Rows the ETL inserts meanwhile it tags itself.
  let tagged = 0;
  for (const [i, [, hi]] of EPOCHS.entries()) {
    if (hi <= TAPROOT_ACTIVATION) continue;
    const part = `utxos_epoch_${i}`;
    const { rows: [{ pages }] } = await pool.query(
      `SELECT (pg_relation_size($1::regclass) / current_setting('block_size')::int)::int AS pages`, [part]
    );
    for (let page = 0; page < pages; page += P2TR_BATCH_PAGES) {
      const res = await withDeadlockRetry(() => pool.query(`
        UPDATE ${part}
        SET pubkey_exposed = loss_bucket <> 2,  -- NUMS output keys (018) stay unflagged
            pubkey_hex = CASE WHEN loss_bucket <> 2 THEN substr(script_hex, 5, 64) END,
            loss_rules = array_append(loss_rules, '019'),
            loss_bucket = CASE WHEN loss_bucket = 0 THEN 4 ELSE loss_bucket END
        WHERE ctid >= $1::tid AND ctid < $2::tid
          AND script_type = 'witness_v1_taproot' AND loss_bucket <> 1 AND NOT loss_rules @> '{019}'
      `, [`(${page},0)`, `(${page + P2TR_BATCH_PAGES},0)`]));
      tagged += res.rowCount ?? 0;
      if ((page / P2TR_BATCH_PAGES) % 20 === 19 || page + P2TR_BATCH_PAGES >= pages) {
        log(`  ${part} page ${Math.min(page + P2TR_BATCH_PAGES, pages)}/${pages}: tagged ${tagged}`);
      }
    }
  }

  // Address level, batched for the same reason. Overwrites any earlier
  // mislabel: the old input heuristic could read a taproot script-path
  // control block as a "pubkey". Temp table, so one dedicated client.
  const client = await pool.connect();
  try {
    log('  collecting taproot addresses');
    await client.query(`
      CREATE TEMP TABLE p2tr_addrs AS
      SELECT address, MIN(pubkey_hex) AS x
      FROM utxos WHERE script_type = 'witness_v1_taproot' AND loss_rules @> '{019}' AND pubkey_exposed
        AND address IS NOT NULL
      GROUP BY address
    `);
    await client.query('CREATE UNIQUE INDEX ON p2tr_addrs (address)');
    await client.query('ANALYZE p2tr_addrs');
    let last = '', marked = 0, batches = 0;
    for (;;) {
      const { rows: b } = await client.query(
        'SELECT address FROM p2tr_addrs WHERE address > $1 ORDER BY address OFFSET $2 LIMIT 1',
        [last, ADDRESS_BATCH - 1]
      );
      const upto: string | null = b[0]?.address ?? null;  // null: final partial batch
      const res = await withDeadlockRetry(() => client.query(`
        UPDATE address_info ai
        SET pubkey_exposed = TRUE, exposure_kind = 'p2tr', is_p2pk = FALSE,
            pubkey_hex = t.x, updated_at = now()
        FROM p2tr_addrs t
        WHERE ai.address = t.address AND ai.exposure_kind IS DISTINCT FROM 'p2tr'
          AND t.address > $1 AND ($2::text IS NULL OR t.address <= $2)
      `, [last, upto]));
      marked += res.rowCount ?? 0;
      if (++batches % 100 === 0) log(`  address_info: ${marked} marked so far`);
      if (upto === null) break;
      last = upto;
    }
    log(`  address_info: ${marked} taproot addresses marked`);
  } finally {
    await client.query('DROP TABLE IF EXISTS p2tr_addrs').catch(() => {});
    client.release();
  }
}

// ---------------------------------------------------------------------------
// p2ms: Proposal 020
// ---------------------------------------------------------------------------
async function phaseP2ms(): Promise<void> {
  log('phase p2ms: bare multisig outputs (020)');
  const { rows } = await pool.query(`
    SELECT tx_hash, output_index, block_number, script_hex, value_sats::text
    FROM utxos WHERE script_type = 'multisig' AND loss_bucket IN (0, 4) AND NOT loss_rules @> '{020}'
  `);
  const targets = rows
    .map(r => ({ ...r, exp: exposedKeysInOutput(r.script_hex) }))
    .filter(r => r.exp?.kind === 'p2ms');
  const sats = targets.reduce((s, r) => s + BigInt(r.value_sats), 0n);
  log(`  ${rows.length} candidates, ${targets.length} with >= M on-curve keys, ${btc(sats)} BTC`);
  if (!EXECUTE) return;
  let n = 0;
  for (const r of targets) {
    const res = await withDeadlockRetry(() => pool.query(`
      UPDATE utxos
      SET pubkey_exposed = TRUE, pubkey_hex = $4,
          loss_rules = array_append(loss_rules, '020'),
          loss_bucket = CASE WHEN loss_bucket = 0 THEN 4 ELSE loss_bucket END
      WHERE tx_hash = $1 AND output_index = $2 AND block_number = $3 AND NOT loss_rules @> '{020}'
    `, [r.tx_hash, r.output_index, r.block_number, r.exp!.keys.join(',')]));
    n += res.rowCount ?? 0;
  }
  log(`  tagged ${n}`);
}

// ---------------------------------------------------------------------------
// scripts: Proposal 021 — chain walk
// ---------------------------------------------------------------------------

async function getState(key: string): Promise<string | null> {
  const { rows } = await pool.query('SELECT value FROM etl_state WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}
async function setState(key: string, value: string): Promise<void> {
  await pool.query(`
    INSERT INTO etl_state (key, value, updated_at) VALUES ($1, $2, now())
    ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()
  `, [key, value]);
}

const SCRIPT_PREVOUT_TYPES = new Set(['scripthash', 'witness_v0_scripthash']);
const PROGRESS_KEY = 'backfill_021_next_block';

async function phaseScripts(): Promise<void> {
  log('phase scripts: keys revealed by historical P2SH / P2WSH spends (021)');
  const from = Number(argValue('--from') ?? (await getState(PROGRESS_KEY)) ?? 0);
  const to = Number(argValue('--to') ?? (await getState('last_synced_block')) ?? 0);
  if (to < from) { log(`  nothing to do (from ${from} > to ${to})`); return; }
  log(`  blocks ${from}..${to}${EXECUTE ? '' : ' (dry run: counting only)'}`);

  const concurrency = Math.max(1, config.etl.concurrency);

  let hits = 0, hitSats = 0n, funded = 0, mixed = 0, inputsSeen = 0;
  const t0 = Date.now();
  let lastReport = t0;

  for (let current = from; current <= to; ) {
    const batch: number[] = [];
    for (let i = 0; i < concurrency && current + i <= to; i++) batch.push(current + i);
    const hashes = await Promise.all(batch.map(h => getBlockHash(h)));
    const blocks = await Promise.all(hashes.map(h => getBlock(h)));

    for (const block of blocks) {
      // Same address, same script: whatever one spend reveals, every other
      // spend reveals too, so the first key-bearing input per address is enough.
      const revealed = new Map<string, Exposure>();
      for (const tx of block.tx) {
        if (tx.vin[0]?.coinbase !== undefined) continue;
        for (const vin of tx.vin) {
          const spk = vin.prevout?.scriptPubKey;
          if (!spk?.address || !SCRIPT_PREVOUT_TYPES.has(spk.type)) continue;
          inputsSeen++;
          if (revealed.has(spk.address)) continue;
          const exp = revealedKeysFromInput(vin);
          if (exp) revealed.set(spk.address, exp);
        }
      }
      if (revealed.size) {
        // One lookup per block. Empty addresses are included on purpose: a
        // later receipt is only flagged if the address is known as exposed.
        const { rows } = await pool.query(
          `SELECT address, utxo_count, utxo_value_sats::text AS sats
           FROM address_info WHERE address = ANY($1::text[]) AND pubkey_exposed = FALSE`,
          [[...revealed.keys()]]
        );
        for (const r of rows) {
          const exp = revealed.get(r.address)!;
          hits++;
          if (Number(r.utxo_count) > 0) { funded++; hitSats += BigInt(r.sats); }
          if (exp.kind === 'script-mixed') mixed++;
        }

        if (EXECUTE && rows.length) {
          // The whole block's marks commit together; on a lost deadlock the
          // transaction is rolled back and replayed (all writes idempotent).
          await withDeadlockRetry(async () => {
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              for (const r of rows) {
                const exp = revealed.get(r.address)!;
                const keys = exp.keys.join(',');
                await markAddr(client, r.address, keys, block.height, exp.kind);
                if (Number(r.utxo_count) > 0) await markUtxos(client, r.address, keys, exposureRule(exp.kind));
              }
              await client.query('COMMIT');
            } catch (err) {
              await client.query('ROLLBACK');
              throw err;
            } finally {
              client.release();
            }
          });
        }
      }

      const now = Date.now();
      if (now - lastReport > 60_000) {
        const rate = (block.height - from + 1) / ((now - t0) / 1000);
        const eta = rate > 0 ? Math.round((to - block.height) / rate / 60) : NaN;
        log(`  block ${block.height}/${to} | script inputs ${inputsSeen} | addresses ${hits} (${funded} funded, ${btc(hitSats)} BTC, ${mixed} mixed) | eta ${eta}m`);
        lastReport = now;
      }
    }

    current += batch.length;
    if (EXECUTE) await setState(PROGRESS_KEY, String(current));
  }

  log(`  done: ${hits} addresses (${funded} funded, ${btc(hitSats)} BTC)${EXECUTE ? ' marked' : ' would be marked'}; ${mixed} mixed-script`);
}

// ---------------------------------------------------------------------------

async function main() {
  log(`backfill-quantum-exposure: phases [${PHASES.join(', ')}] ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}`);
  const runners: Record<string, () => Promise<void>> = {
    fix: phaseFix, kinds: phaseKinds, receipts: phaseReceipts,
    p2tr: phaseP2tr, p2ms: phaseP2ms, scripts: phaseScripts,
  };
  for (const p of PHASES) {
    const run = runners[p];
    if (!run) { console.error(`unknown phase: ${p}`); process.exit(1); }
    await run();
  }
  if (!EXECUTE) log('DRY RUN — nothing written. Re-run with --execute to apply.');
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
