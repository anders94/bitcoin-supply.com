// One-off backfill for the quantum-exposure rules added 2026-10-13 (see
// docs/quantum-exposure-plan.md). New blocks are handled by the ETL; this
// brings everything already indexed up to the same rules.
//
// Phases (comma-separated via --phase; default runs the SQL-only ones):
//
//   fix       Clear the exposed flag on provably-lost P2PK rows. The old ETL
//             flagged every P2PK-shaped script, including off-curve keys that
//             have no private key to derive.
//   kinds     Fill address_info.exposure_kind for rows written before
//             migration 008 (p2pk if is_p2pk, else pkh).
//   receipts  Flag UTXOs received at an address *after* its key was revealed
//             (016 / 021). The largest single correction, ~2.3M BTC.
//   p2tr      Proposal 019: every on-curve taproot output, plus address_info.
//   p2ms      Proposal 020: bare multisig with >= M on-curve keys.
//   scripts   Proposal 021: keys revealed by historical P2SH / P2WSH spends.
//             The database keeps no spent inputs, so this walks the chain over
//             RPC. Only inputs whose prevout address still holds a balance are
//             considered. Resumable: progress is kept in etl_state under
//             'backfill_021_next_block'. Run it on the ETL box.
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
import { createHash } from 'node:crypto';
import { pool } from '../src/db/index.js';
import { config } from '../src/config.js';
import { getBlockHash, getBlock } from '../src/services/bitcoin-rpc.js';
import { exposedKeysInOutput, revealedKeysFromInput, exposureRule } from '../src/classifiers/exposure.js';
import { markAddressPubkeyExposed as markAddr } from '../src/db/address-info.js';
import { markAddressPubkeyExposed as markUtxos } from '../src/db/utxos.js';

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const argValue = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const PHASES = (argValue('--phase') ?? 'fix,kinds,receipts,p2tr,p2ms').split(',').map(s => s.trim());

// utxos is partitioned by halving epoch; one statement per partition keeps
// each transaction (and its WAL) bounded.
const EPOCHS: [number, number][] = [
  [0, 210_000], [210_000, 420_000], [420_000, 630_000], [630_000, 840_000], [840_000, 1_050_000],
];

const btc = (sats: bigint | string | number) => (Number(sats) / 1e8).toFixed(8);
const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

// ---------------------------------------------------------------------------
// fix: off-curve P2PK rows carry no breakable key
// ---------------------------------------------------------------------------
async function phaseFix(): Promise<void> {
  log('phase fix: provably-lost rows flagged exposed');
  const { rows } = await pool.query(`
    SELECT COUNT(*)::text AS n, COALESCE(SUM(value_sats), 0)::text AS sats
    FROM utxos WHERE loss_bucket = 1 AND pubkey_exposed = TRUE
  `);
  log(`  ${rows[0].n} rows, ${btc(rows[0].sats)} BTC`);
  if (!EXECUTE) return;
  for (const [lo, hi] of EPOCHS) {
    const res = await pool.query(`
      UPDATE utxos SET pubkey_exposed = FALSE, pubkey_hex = NULL
      WHERE loss_bucket = 1 AND pubkey_exposed = TRUE AND block_number >= $1 AND block_number < $2
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
  const { rows } = await pool.query(`
    SELECT COUNT(*)::text AS n, COALESCE(SUM(u.value_sats), 0)::text AS sats
    FROM utxos u JOIN address_info ai ON ai.address = u.address
    WHERE ai.pubkey_exposed AND NOT u.pubkey_exposed AND u.loss_bucket <> 1
  `);
  log(`  ${rows[0].n} rows, ${btc(rows[0].sats)} BTC`);
  if (!EXECUTE) return;
  for (const [lo, hi] of EPOCHS) {
    const res = await pool.query(`
      UPDATE utxos u
      SET pubkey_exposed = TRUE,
          pubkey_hex = COALESCE(ai.pubkey_hex, u.pubkey_hex),
          loss_rules = CASE
            WHEN u.loss_bucket = 0 AND NOT u.loss_rules @> ARRAY[k.rule] THEN array_append(u.loss_rules, k.rule)
            ELSE u.loss_rules END
      FROM address_info ai,
           LATERAL (SELECT CASE WHEN ai.exposure_kind IN ('script', 'script-mixed') THEN '021' ELSE '016' END AS rule) k
      WHERE ai.address = u.address AND ai.pubkey_exposed
        AND NOT u.pubkey_exposed AND u.loss_bucket <> 1
        AND u.block_number >= $1 AND u.block_number < $2
    `, [lo, hi]);
    log(`  epoch ${lo}-${hi}: flagged ${res.rowCount}`);
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
  for (const [lo, hi] of EPOCHS) {
    if (hi <= 709_632) continue; // taproot activation
    const res = await pool.query(`
      UPDATE utxos
      SET pubkey_exposed = TRUE,
          pubkey_hex = substr(script_hex, 5, 64),
          loss_rules = array_append(loss_rules, '019'),
          loss_bucket = CASE WHEN loss_bucket = 0 THEN 4 ELSE loss_bucket END
      WHERE script_type = 'witness_v1_taproot' AND loss_bucket <> 1 AND NOT loss_rules @> '{019}'
        AND block_number >= $1 AND block_number < $2
    `, [lo, hi]);
    log(`  epoch ${lo}-${hi}: tagged ${res.rowCount}`);
  }
  // Address level. Overwrites any earlier mislabel: the old input heuristic
  // could read a taproot script-path control block as a "pubkey".
  const res = await pool.query(`
    UPDATE address_info ai
    SET pubkey_exposed = TRUE, exposure_kind = 'p2tr', is_p2pk = FALSE,
        pubkey_hex = t.x, updated_at = now()
    FROM (
      SELECT address, MIN(pubkey_hex) AS x
      FROM utxos WHERE script_type = 'witness_v1_taproot' AND loss_rules @> '{019}' AND address IS NOT NULL
      GROUP BY address
    ) t
    WHERE ai.address = t.address AND ai.exposure_kind IS DISTINCT FROM 'p2tr'
  `);
  log(`  address_info: ${res.rowCount} taproot addresses marked`);
}

// ---------------------------------------------------------------------------
// p2ms: Proposal 020
// ---------------------------------------------------------------------------
async function phaseP2ms(): Promise<void> {
  log('phase p2ms: bare multisig outputs (020)');
  const { rows } = await pool.query(`
    SELECT tx_hash, output_index, block_number, script_hex, value_sats::text
    FROM utxos WHERE script_type = 'multisig' AND loss_bucket <> 1 AND NOT loss_rules @> '{020}'
  `);
  const targets = rows
    .map(r => ({ ...r, exp: exposedKeysInOutput(r.script_hex) }))
    .filter(r => r.exp?.kind === 'p2ms');
  const sats = targets.reduce((s, r) => s + BigInt(r.value_sats), 0n);
  log(`  ${rows.length} candidates, ${targets.length} with >= M on-curve keys, ${btc(sats)} BTC`);
  if (!EXECUTE) return;
  let n = 0;
  for (const r of targets) {
    const res = await pool.query(`
      UPDATE utxos
      SET pubkey_exposed = TRUE, pubkey_hex = $4,
          loss_rules = array_append(loss_rules, '020'),
          loss_bucket = CASE WHEN loss_bucket = 0 THEN 4 ELSE loss_bucket END
      WHERE tx_hash = $1 AND output_index = $2 AND block_number = $3 AND NOT loss_rules @> '{020}'
    `, [r.tx_hash, r.output_index, r.block_number, r.exp!.keys.join(',')]);
    n += res.rowCount ?? 0;
  }
  log(`  tagged ${n}`);
}

// ---------------------------------------------------------------------------
// scripts: Proposal 021 — chain walk
// ---------------------------------------------------------------------------

// Candidate addresses are held as sorted 64-bit hashes (8 bytes each instead
// of ~80 for a JS string) with a done-bitmap alongside. A hit is confirmed
// against the database before anything is written, so a collision can only
// cost a lookup, never a wrong flag.
const h64 = (s: string): bigint => createHash('sha256').update(s).digest().readBigUInt64LE(0);

class CandidateSet {
  private hashes: BigUint64Array;
  private done: Uint8Array;
  constructor(hashes: BigUint64Array) {
    this.hashes = hashes.sort();
    this.done = new Uint8Array(hashes.length);
  }
  get size() { return this.hashes.length; }
  // Index of the hash, or -1 when absent or already handled.
  find(address: string): number {
    const h = h64(address);
    let lo = 0, hi = this.hashes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = this.hashes[mid];
      if (v === h) return this.done[mid] ? -1 : mid;
      if (v < h) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }
  settle(i: number) { this.done[i] = 1; }
}

async function loadCandidates(): Promise<CandidateSet> {
  // P2SH (3…) and P2WSH (bc1q…, 62 chars) addresses that still hold coin and
  // are not yet exposed. P2SH-P2WPKH addresses that already spent were caught
  // by the old ETL (witness[1]) and are excluded by pubkey_exposed = FALSE.
  const where = `utxo_count > 0 AND pubkey_exposed = FALSE
    AND (address LIKE '3%' OR (address LIKE 'bc1q%' AND length(address) = 62))`;
  const { rows: [{ n }] } = await pool.query(`SELECT COUNT(*)::text AS n FROM address_info WHERE ${where}`);
  const total = Number(n);
  log(`  ${total} candidate script-hash addresses with a balance`);
  const hashes = new BigUint64Array(total);
  let i = 0;
  let last = '';
  for (;;) {
    const { rows } = await pool.query(
      `SELECT address FROM address_info WHERE ${where} AND address > $1 ORDER BY address LIMIT 200000`, [last]
    );
    if (!rows.length) break;
    for (const r of rows) { if (i < total) hashes[i++] = h64(r.address); }
    last = rows[rows.length - 1].address;
    if (i % 1_000_000 < 200000) log(`  loaded ${i}/${total}`);
  }
  return new CandidateSet(i === total ? hashes : hashes.slice(0, i));
}

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

  const candidates = await loadCandidates();
  const concurrency = Math.max(1, config.etl.concurrency);

  let hits = 0, hitSats = 0n, mixed = 0, inputsSeen = 0;
  const t0 = Date.now();
  let lastReport = t0;

  for (let current = from; current <= to; ) {
    const batch: number[] = [];
    for (let i = 0; i < concurrency && current + i <= to; i++) batch.push(current + i);
    const hashes = await Promise.all(batch.map(h => getBlockHash(h)));
    const blocks = await Promise.all(hashes.map(h => getBlock(h)));

    for (const block of blocks) {
      for (const tx of block.tx) {
        if (tx.vin[0]?.coinbase !== undefined) continue;
        for (const vin of tx.vin) {
          const spk = vin.prevout?.scriptPubKey;
          if (!spk?.address || !SCRIPT_PREVOUT_TYPES.has(spk.type)) continue;
          inputsSeen++;
          const idx = candidates.find(spk.address);
          if (idx < 0) continue;
          // Same address, same script: whatever this spend reveals, every
          // other spend reveals too. One look is enough either way.
          candidates.settle(idx);
          const exp = revealedKeysFromInput(vin);
          if (!exp) continue;

          // Confirm the hit (hash collision guard) and read the balance.
          const { rows } = await pool.query(
            'SELECT utxo_value_sats::text AS sats FROM address_info WHERE address = $1 AND pubkey_exposed = FALSE AND utxo_count > 0',
            [spk.address]
          );
          if (!rows.length) continue;
          hits++;
          hitSats += BigInt(rows[0].sats);
          if (exp.kind === 'script-mixed') mixed++;

          if (EXECUTE) {
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              const keys = exp.keys.join(',');
              await markAddr(client, spk.address, keys, block.height, exp.kind);
              await markUtxos(client, spk.address, keys, exposureRule(exp.kind));
              await client.query('COMMIT');
            } catch (err) {
              await client.query('ROLLBACK');
              throw err;
            } finally {
              client.release();
            }
          }
        }
      }

      const now = Date.now();
      if (now - lastReport > 60_000) {
        const rate = (block.height - from + 1) / ((now - t0) / 1000);
        const eta = rate > 0 ? Math.round((to - block.height) / rate / 60) : NaN;
        log(`  block ${block.height}/${to} | script inputs ${inputsSeen} | hits ${hits} (${btc(hitSats)} BTC, ${mixed} mixed) | eta ${eta}m`);
        lastReport = now;
      }
    }

    current += batch.length;
    if (EXECUTE) await setState(PROGRESS_KEY, String(current));
  }

  log(`  done: ${hits} addresses, ${btc(hitSats)} BTC${EXECUTE ? ' flagged' : ' would be flagged'}; ${mixed} mixed-script`);
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
