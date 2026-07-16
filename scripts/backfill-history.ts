// One-time backfill of snapshot_history with year-end provable-loss totals.
//
// Exact retro-computation is possible because bucket-1 UTXOs are spent to
// unspendable conditions: they are never deleted from the utxos table, so the
// cumulative provable loss at any past year end is the sum of loss UTXOs
// created up to that point (plus miner underclaims from blocks).
//
// Run once: npx tsx scripts/backfill-history.ts

import 'dotenv/config';
import { pool } from '../src/db/index.js';

async function main() {
  const { rows } = await pool.query(`
    WITH per_year AS (
      SELECT EXTRACT(YEAR FROM block_timestamp)::int AS y,
             SUM(value_sats)::text AS sats, COUNT(*)::text AS n
      FROM utxos WHERE loss_bucket = 1 GROUP BY 1
    ),
    miner AS (
      SELECT EXTRACT(YEAR FROM block_timestamp)::int AS y,
             SUM(miner_loss_sats)::text AS sats,
             MAX(block_number)::int AS last_block
      FROM blocks WHERE miner_loss_sats > 0 GROUP BY 1
    ),
    year_tip AS (
      SELECT EXTRACT(YEAR FROM block_timestamp)::int AS y, MAX(block_number)::int AS tip
      FROM blocks GROUP BY 1
    )
    SELECT t.y,
           COALESCE(p.sats, '0') AS utxo_sats, COALESCE(p.n, '0') AS utxo_n,
           COALESCE(m.sats, '0') AS miner_sats,
           t.tip
    FROM year_tip t
    LEFT JOIN per_year p ON p.y = t.y
    LEFT JOIN miner m ON m.y = t.y
    ORDER BY t.y
  `);

  const currentYear = new Date().getUTCFullYear();
  let cumSats = 0n;
  let cumCount = 0n;
  let inserted = 0;

  for (const row of rows) {
    cumSats += BigInt(row.utxo_sats) + BigInt(row.miner_sats);
    cumCount += BigInt(row.utxo_n);
    if (row.y >= currentYear) continue; // current year is covered by the hourly job

    const { rowCount } = await pool.query(`
      INSERT INTO snapshot_history (as_of_date, snapshot_key, total_sats, utxo_count, computed_at_block, computed_at)
      VALUES (make_date($1, 12, 31), 'provably_lost', $2, $3, $4, now())
      ON CONFLICT (as_of_date, snapshot_key) DO NOTHING
    `, [row.y, cumSats, cumCount, row.tip]);
    inserted += rowCount ?? 0;
    console.log(`${row.y}-12-31  provably_lost  ${cumSats} sats (${cumCount} utxos, tip ${row.tip})${rowCount ? '' : '  [exists, skipped]'}`);
  }

  console.log(`Backfill complete: ${inserted} row(s) inserted.`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
