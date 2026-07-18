// One-off backfill for Proposal 018 (NUMS-key burns): tag existing utxos rows
// that pay to a documented NUMS key in any wrapping. New blocks are classified
// by the ETL going forward; this catches everything already indexed.
//
// Cheap by design (nothing like the zero-value cleanup):
//   * Address wrappings use idx_utxos_address_value — a handful of indexed
//     lookups.
//   * script_hex wrappings have no index, so they are found with ONE parallel
//     seq scan (SELECT only), then updated by primary key. Measured 0 matching
//     rows in production as of 2026-07-18, so the scan is expected to write
//     nothing — it exists to make the backfill complete, not because we expect
//     hits.
//
// Idempotent: rows already tagged '018' are skipped, so it can be re-run at any
// time (e.g. after the ETL deploy, to close any gap). Bucket update mirrors the
// computeBucket ladder: provably-lost rows (bucket 1) keep their bucket; only
// active (0) or quantum (4) rows move to probably-lost (2).
//
// Usage:
//   npx tsx scripts/backfill-nums-keys.ts             # dry run
//   npx tsx scripts/backfill-nums-keys.ts --execute
//
// Afterwards no manual snapshot is required: rule_breakdown unnests loss_rules
// dynamically, so '018' totals appear at the ETL's next hourly snapshot.

import 'dotenv/config';
import { pool } from '../src/db/index.js';
import { loadNumsMatcher } from '../src/classifiers/nums.js';

const EXECUTE = process.argv.includes('--execute');

async function main() {
  const matcher = await loadNumsMatcher(pool);
  const addresses = [...matcher.addresses];
  const scriptHexes = [...matcher.scriptHexes];
  console.log(`NUMS matcher: ${scriptHexes.length} script forms, ${addresses.length} addresses`);

  // ---- address wrappings (indexed) ----------------------------------------
  const { rows: addrRows } = await pool.query(`
    SELECT tx_hash, output_index, block_number, value_sats::text, address, loss_bucket, loss_rules
    FROM utxos
    WHERE address = ANY($1) AND NOT loss_rules @> '{018}'
  `, [addresses]);

  // ---- script wrappings (one parallel scan, SELECT only) ------------------
  console.log('scanning for script-form matches (parallel seq scan, ~1-2 min)...');
  const { rows: scriptRows } = await pool.query(`
    SELECT tx_hash, output_index, block_number, value_sats::text, address, loss_bucket, loss_rules
    FROM utxos
    WHERE script_hex = ANY($1) AND NOT loss_rules @> '{018}'
  `, [scriptHexes]);

  const targets = [...addrRows, ...scriptRows];
  const totalSats = targets.reduce((s, r) => s + BigInt(r.value_sats), 0n);
  console.log(`\nrows to tag '018': ${targets.length}`
    + ` (${addrRows.length} by address, ${scriptRows.length} by script)`
    + ` — ${(Number(totalSats) / 1e8).toFixed(8)} BTC`);
  for (const r of targets.slice(0, 20)) {
    console.log(`  ${r.tx_hash.slice(0, 16)}…:${r.output_index}`
      + ` block ${r.block_number} bucket ${r.loss_bucket} ${r.value_sats} sats`);
  }

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing updated. Re-run with --execute to apply.');
    await pool.end();
    return;
  }

  let updated = 0;
  for (const r of targets) {
    const res = await pool.query(`
      UPDATE utxos
      SET loss_rules = array_append(loss_rules, '018'),
          loss_bucket = CASE WHEN loss_bucket IN (0, 4) THEN 2 ELSE loss_bucket END
      WHERE tx_hash = $1 AND output_index = $2 AND block_number = $3
        AND NOT loss_rules @> '{018}'
    `, [r.tx_hash, r.output_index, r.block_number]);
    updated += res.rowCount ?? 0;
  }
  console.log(`\nupdated ${updated} row(s).`);
  console.log("'018' totals appear at the next hourly ETL snapshot (rule_breakdown is dynamic).");
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
