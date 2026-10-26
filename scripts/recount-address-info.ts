// One-off repair of address_info's running counters (utxo_count,
// utxo_value_sats) against the utxos table.
//
// Before 6bc7520 a reprocessed block replayed its spends and receipts blindly,
// decrementing or incrementing the counters a second time. The ETL has been
// idempotent since, but the drift it left was never recounted: addresses that
// hold coins showing a wrong (often zero) balance, and fully spent addresses
// still showing a "ghost" balance. The headline figures come from utxos and are
// unaffected; the per-address views (top exposed addresses, address pages,
// counts by kind) read these counters.
//
// The quantum backfill trusted utxo_count > 0 to skip empty addresses, so coins
// at an exposed address whose count had drifted to 0 were never flagged. Each
// repaired address that is exposed by a spend gets its unflagged coins flagged.
//
// Usage:
//   npx tsx scripts/recount-address-info.ts            # dry run: count only
//   npx tsx scripts/recount-address-info.ts --execute
//
// Finding candidates takes about an hour (one pass over utxos, one over every
// address_info row with a balance). The repair recounts each batch from live
// utxos under row locks, so the ETL may keep running alongside, and a re-run
// is safe.

import 'dotenv/config';
import { pool } from '../src/db/index.js';
import { exposureRule, ExposureKind } from '../src/classifiers/exposure.js';
import { markAddressPubkeyExposed as markUtxos } from '../src/db/utxos.js';

const EXECUTE = process.argv.includes('--execute');
const BATCH = 2_000;

const btc = (sats: bigint | string | number) => (Number(sats) / 1e8).toFixed(8);
const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

// The live ETL locks the same address_info rows in its own order; whichever
// side loses a deadlock (40P01) rolls back. Every write here is idempotent.
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

async function main() {
  log(`recount-address-info: ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}`);

  // Temp tables live on one session.
  const client = await pool.connect();
  let addresses: string[];
  try {
    await client.query(`SET work_mem = '1GB'`);
    log('  counting utxos by address');
    await client.query(`
      CREATE TEMP TABLE actual AS
      SELECT address, COUNT(*)::int AS c, SUM(value_sats)::bigint AS s
      FROM utxos WHERE address IS NOT NULL GROUP BY address
    `);
    await client.query('ANALYZE actual');

    // The planner underestimates distinct addresses ~100x and picks a nested
    // loop over 57M rows; a hash join is far faster here.
    await client.query('SET enable_nestloop = off');
    log('  finding addresses whose counters disagree');
    await client.query(`
      CREATE TEMP TABLE candidates AS
      SELECT a.address FROM actual a JOIN address_info ai ON ai.address = a.address
      WHERE ai.utxo_count <> a.c OR ai.utxo_value_sats <> a.s
    `);
    await client.query('SET enable_nestloop = on');

    log('  finding ghost balances on spent-out addresses');
    await client.query(`
      INSERT INTO candidates
      SELECT ai.address FROM address_info ai
      WHERE ai.utxo_value_sats > 0
        AND NOT EXISTS (SELECT 1 FROM actual a WHERE a.address = ai.address)
    `);

    const { rows } = await client.query(`
      SELECT c.address, ai.utxo_value_sats::text AS stored, COALESCE(a.s, 0)::text AS real
      FROM candidates c
      JOIN address_info ai ON ai.address = c.address
      LEFT JOIN actual a ON a.address = c.address
      ORDER BY c.address
    `);
    addresses = rows.map(r => r.address);
    const off = rows.reduce((acc, r) => {
      const d = BigInt(r.stored) - BigInt(r.real);
      return acc + (d < 0n ? -d : d);
    }, 0n);
    log(`  ${addresses.length} addresses to repair, ${btc(off)} BTC of balance misstated`);
  } finally {
    client.release();
  }

  if (!EXECUTE) {
    log('DRY RUN — nothing written. Re-run with --execute to apply.');
    await pool.end();
    return;
  }

  let fixed = 0, flagged = 0;
  for (let i = 0; i < addresses.length; i += BATCH) {
    const batch = addresses.slice(i, i + BATCH);
    // Counts come back from the closure so a replayed batch isn't added twice.
    const [f, n] = await withDeadlockRetry(async (): Promise<[number, number]> => {
      const c = await pool.connect();
      let batchFlagged = 0;
      try {
        await c.query('BEGIN');
        // Lock first: an ETL transaction touching one of these addresses either
        // committed already (and is counted below) or waits for us, and then
        // applies its own +1 / -1 on top of the corrected value.
        await c.query(
          'SELECT 1 FROM address_info WHERE address = ANY($1::text[]) ORDER BY address FOR UPDATE',
          [batch]
        );
        const res = await c.query(`
          UPDATE address_info ai
          SET utxo_count = x.c, utxo_value_sats = x.s, updated_at = now()
          FROM unnest($1::text[]) AS v(address)
          CROSS JOIN LATERAL (
            SELECT COUNT(*)::int AS c, COALESCE(SUM(value_sats), 0)::bigint AS s
            FROM utxos u WHERE u.address = v.address
          ) x
          WHERE ai.address = v.address
            AND (ai.utxo_count <> x.c OR ai.utxo_value_sats <> x.s)
          RETURNING ai.address, ai.utxo_count, ai.pubkey_exposed, ai.pubkey_hex,
            COALESCE(ai.exposure_kind, CASE WHEN ai.is_p2pk THEN 'p2pk' ELSE 'pkh' END) AS kind
        `, [batch]);

        // Key in the output script (p2pk / p2tr / p2ms): the ETL flags those
        // coins at insert, independent of the counters.
        for (const r of res.rows) {
          const kind = r.kind as ExposureKind;
          if (!r.pubkey_exposed || !r.pubkey_hex || Number(r.utxo_count) === 0) continue;
          if (kind === 'p2pk' || kind === 'p2tr' || kind === 'p2ms') continue;
          const m = await c.query(`
            SELECT COUNT(*)::int AS n FROM utxos
            WHERE address = $1 AND pubkey_exposed = FALSE AND loss_bucket IN (0, 4)
          `, [r.address]);
          if (m.rows[0].n === 0) continue;
          await markUtxos(c, r.address, r.pubkey_hex, exposureRule(kind));
          batchFlagged += m.rows[0].n;
        }
        await c.query('COMMIT');
        return [res.rowCount ?? 0, batchFlagged];
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      } finally {
        c.release();
      }
    });
    fixed += f;
    flagged += n;
    log(`  ${Math.min(i + BATCH, addresses.length)}/${addresses.length} | repaired ${fixed} | exposed coins flagged ${flagged}`);
  }

  log(`done: ${fixed} addresses repaired, ${flagged} exposed coins flagged`);
  if (flagged > 0) log('Run `npm run snapshot` (or wait for the hourly job) to refresh the quantum figures.');
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
