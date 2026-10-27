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
//   siblings  Proposal 022: a known key also exposes its other single-key
//             addresses (P2PKH / P2WPKH / P2SH-P2WPKH, compressed and, for
//             uncompressed keys, uncompressed). Two sequential passes over
//             address_info: collect every unexposed address, then derive the
//             siblings of every known key and match in memory; only matches
//             touch the database. Marks empty addresses too, so later receipts
//             are flagged by the ETL. A few hours; DB only. Pass 2 resumes via
//             etl_state 'backfill_022_next_page'. Re-runnable to pick up
//             siblings first funded after their key was revealed.
//   outkeys   Proposal 022, the rest: siblings of keys in P2PK and bare-multisig
//             outputs that are already spent (siblings reads only unspent
//             ones from utxos). Walks every block's outputs over RPC
//             (verbosity 2, no prevouts). Resumable via etl_state
//             'backfill_022_next_block'; run it on the ETL box.
//   keyindex  Proposal 022 at receipt time: fill revealed_key_hashes (migration
//             009) from every key already public, so the ETL can tell when an
//             address receiving its first coins belongs to one. One pass over
//             address_info plus the P2PK / bare-multisig keys in utxos. Builds
//             a side table, indexes it, then swaps it in (the ETL keeps
//             inserting into the live table meanwhile; those rows are carried
//             over). 12-20 hours, ~1.8B rows / ~180 GB. Resumable via
//             etl_state 'backfill_keyindex_next_page'.
//   hybrid    P2PK / bare-multisig outputs whose only usable keys are hybrid
//             (06 / 07): classified provably lost (005 / 006) before
//             isOnSecp256k1Curve accepted that encoding. Retags them 015 / 020
//             and marks the key's sibling addresses (022). One utxos scan.
//
// Usage:
//   npx tsx scripts/backfill-quantum-exposure.ts                      # dry run, SQL phases
//   npx tsx scripts/backfill-quantum-exposure.ts --execute
//   npx tsx scripts/backfill-quantum-exposure.ts --phase scripts --execute [--from N] [--to N]
//   npx tsx scripts/backfill-quantum-exposure.ts --phase siblings --execute
//   npx tsx scripts/backfill-quantum-exposure.ts --phase outkeys --execute [--from N] [--to N]
//   npx tsx scripts/backfill-quantum-exposure.ts --phase keyindex --execute
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
import {
  exposedKeysInOutput, revealedKeysFromInput, exposureRule, Exposure,
  keyHashes, base58check, segwitV0Address, siblingAddresses, addressPayload, reverseIndexEntries,
} from '../src/classifiers/exposure.js';
import { parseMultisigScript } from '../src/classifiers/proposals-000-011.js';
import { markAddressPubkeyExposed as markUtxos } from '../src/db/utxos.js';
import { markSiblingAddresses, KEYINDEX_BUILT_KEY } from '../src/db/address-info.js';
import { computeBucket, RuleId } from '../src/classifiers/index.js';

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
  // bitcoind calls a multisig 'nonstandard' when any key is malformed, as in
  // Counterparty's 1-of-2 outputs (one real key, one data push). One valid key
  // still meets M = 1, so the script shape decides, not script_type.
  const { rows } = await pool.query(`
    SELECT tx_hash, output_index, block_number, script_hex, value_sats::text
    FROM utxos WHERE script_type IN ('multisig', 'nonstandard') AND loss_bucket IN (0, 4)
      AND NOT loss_rules @> '{020}'
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

  // Proposal 022 for the same keys, once per distinct key.
  const keys = new Map<string, number>();
  for (const r of targets) for (const k of r.exp!.keys) if (!keys.has(k)) keys.set(k, Number(r.block_number));
  const tally = newTally();
  const hits: SiblingHit[] = [];
  for (const [k, block] of keys) for (const s of siblingAddresses(k)) hits.push({ ...s, block });
  for (let i = 0; i < hits.length; i += 5_000) await applySiblingHits(hits.slice(i, i + 5_000), tally);
  log(`  siblings (022) of ${keys.size} keys: ${tallyLine(tally)}`);
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
              // All of the block's addresses in one statement (~hundreds per
              // block, nearly all empty); same SET as markAddressPubkeyExposed.
              const addrs = rows.map(r => r.address as string);
              const exps = addrs.map(a => revealed.get(a)!);
              await client.query(`
                UPDATE address_info ai
                SET pubkey_hex = v.keys, pubkey_exposed_at_block = $4, pubkey_exposed = TRUE,
                    exposure_kind = COALESCE(ai.exposure_kind, v.kind), updated_at = now()
                FROM unnest($1::text[], $2::text[], $3::text[]) AS v(address, keys, kind)
                WHERE ai.address = v.address AND ai.pubkey_hex IS NULL
              `, [addrs, exps.map(e => e.keys.join(',')), exps.map(e => e.kind), block.height]);
              // UTXO rows only exist at funded addresses.
              for (const r of rows) {
                if (Number(r.utxo_count) === 0) continue;
                const exp = revealed.get(r.address)!;
                await markUtxos(client, r.address, exp.keys.join(','), exposureRule(exp.kind));
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
// siblings: Proposal 022, a key's other single-key addresses
// ---------------------------------------------------------------------------

const SIBLING_BATCH_PAGES = 20_000;  // ~160 MB of address_info heap per query
const SIBLING_PROGRESS_KEY = 'backfill_022_next_page';

// Sorted first-8-byte prefixes of every target payload: ~8 bytes per address
// instead of a JS string, and a binary search per lookup.
class PrefixSet {
  private chunks: BigUint64Array[] = [];
  private cur = new BigUint64Array(1 << 24);
  private n = 0;
  private sorted = new BigUint64Array(0);
  add(payload: Buffer) {
    if (this.n === this.cur.length) { this.chunks.push(this.cur); this.cur = new BigUint64Array(1 << 24); this.n = 0; }
    this.cur[this.n++] = payload.readBigUInt64BE(0);
  }
  seal(): number {
    const total = this.chunks.length * (1 << 24) + this.n;
    this.sorted = new BigUint64Array(total);
    let off = 0;
    for (const c of this.chunks) { this.sorted.set(c, off); off += c.length; }
    this.sorted.set(this.cur.subarray(0, this.n), off);
    this.chunks = []; this.cur = new BigUint64Array(0);
    this.sorted.sort();
    return total;
  }
  has(payload: Buffer): boolean {
    const x = payload.readBigUInt64BE(0);
    let lo = 0, hi = this.sorted.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = this.sorted[mid];
      if (v === x) return true;
      if (v < x) lo = mid + 1; else hi = mid - 1;
    }
    return false;
  }
}

interface SiblingHit { address: string; key: string; block: number | null; }
interface SiblingTally { marked: number; funded: number; flagged: number; sats: bigint; }

const newTally = (): SiblingTally => ({ marked: 0, funded: 0, flagged: 0, sats: 0n });
const tallyLine = (t: SiblingTally) =>
  `addresses ${t.marked} (${t.funded} funded, ${btc(t.sats)} BTC)${EXECUTE ? ` | coins flagged ${t.flagged}` : ''}`;

// Confirm candidate siblings against the database (prefix matches and address
// types are only candidates) and mark them in one statement. First exposure
// wins: an address already holding a key is left alone, and among duplicate
// hits the first (earliest block, when hits arrive in chain order) is kept.
async function applySiblingHits(hits: SiblingHit[], tally: SiblingTally): Promise<void> {
  if (hits.length === 0) return;
  const uniq = new Map<string, SiblingHit>();
  for (const h of hits) if (!uniq.has(h.address)) uniq.set(h.address, h);
  const hs = [...uniq.values()];
  if (!EXECUTE) {
    const { rows } = await pool.query(`
      SELECT address, utxo_count, utxo_value_sats::text AS sats FROM address_info
      WHERE address = ANY($1::text[]) AND pubkey_hex IS NULL
    `, [hs.map(h => h.address)]);
    for (const r of rows) {
      tally.marked++;
      if (Number(r.utxo_count) > 0) { tally.funded++; tally.sats += BigInt(r.sats); }
    }
    return;
  }
  await withDeadlockRetry(async () => {
    const client = await pool.connect();
    let m = 0, f = 0, fl = 0, sats = 0n;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`
        UPDATE address_info ai
        SET pubkey_hex = v.key, pubkey_exposed_at_block = v.block, pubkey_exposed = TRUE,
            exposure_kind = COALESCE(ai.exposure_kind, 'reuse'), updated_at = now()
        FROM unnest($1::text[], $2::text[], $3::int[]) AS v(address, key, block)
        WHERE ai.address = v.address AND ai.pubkey_hex IS NULL
        RETURNING ai.address, ai.utxo_count, ai.utxo_value_sats::text AS sats, v.key
      `, [hs.map(h => h.address), hs.map(h => h.key), hs.map(h => h.block)]);
      for (const r of rows) {
        m++;
        if (Number(r.utxo_count) === 0) continue;
        f++; sats += BigInt(r.sats);
        const res = await client.query(`
          SELECT COUNT(*)::int AS n FROM utxos
          WHERE address = $1 AND pubkey_exposed = FALSE AND loss_bucket IN (0, 4)
        `, [r.address]);
        fl += res.rows[0].n;
        await markUtxos(client, r.address, r.key, '022');
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    tally.marked += m; tally.funded += f; tally.flagged += fl; tally.sats += sats;
  });
}

async function phaseSiblings(): Promise<void> {
  log('phase siblings: other addresses of known keys (022)');
  const { rows: [{ pages }] } = await pool.query(
    `SELECT (pg_relation_size('address_info') / current_setting('block_size')::int)::int AS pages`
  );

  // Pass 1: every not-yet-exposed P2PKH / P2SH / P2WPKH address.
  const targets = new PrefixSet();
  for (let page = 0; page < pages; page += SIBLING_BATCH_PAGES) {
    const { rows } = await pool.query(`
      SELECT address FROM address_info
      WHERE ctid >= $1::tid AND ctid < $2::tid AND pubkey_exposed = FALSE
    `, [`(${page},0)`, `(${page + SIBLING_BATCH_PAGES},0)`]);
    for (const r of rows) {
      const p = addressPayload(r.address)?.payload;
      if (p) targets.add(p);
    }
    if ((page / SIBLING_BATCH_PAGES) % 200 === 199) log(`  pass 1: page ${page + SIBLING_BATCH_PAGES}/${pages}`);
  }
  log(`  pass 1: ${targets.seal()} unexposed single-key-type addresses`);

  // Every candidate sibling of `keys` that is in the target set.
  const match = (keys: string[], block: number | null, out: SiblingHit[]) => {
    for (const k of keys) {
      for (const { key, h160, p2shH160 } of keyHashes(k)) {
        if (targets.has(h160)) {
          out.push({ address: base58check(0x00, h160), key, block });
          out.push({ address: segwitV0Address(h160), key, block });
        }
        if (targets.has(p2shH160)) out.push({ address: base58check(0x05, p2shH160), key, block });
      }
    }
  };

  const tally = newTally();
  const apply = (hits: SiblingHit[]) => applySiblingHits(hits, tally);
  const report = (where: string) => log(`  ${where} | ${tallyLine(tally)}`);

  // Keys in output scripts: P2PK (015) and bare multisig (020) still unspent,
  // plus the lost-bucket coinbase keys (genesis, BIP-30 duplicates), whose
  // keys are valid even though those outputs can never move.
  const { rows: inScript } = await pool.query(`
    SELECT script_hex, MIN(block_number) AS block FROM utxos
    WHERE script_type IN ('pubkey', 'multisig', 'nonstandard') AND loss_bucket IN (1, 4)
    GROUP BY script_hex
  `);
  const scriptHits: SiblingHit[] = [];
  for (const r of inScript) {
    // On-curve keys only: off-curve "keys" (005 / 006) have no private key.
    match(exposedKeysInOutput(r.script_hex)?.keys ?? [], Number(r.block), scriptHits);
  }
  await apply(scriptHits);
  report(`output-script keys (${inScript.length} scripts)`);

  // Pass 2: keys known from address_info (spends, and legacy P2PK rows).
  // Taproot output keys have no siblings; 'reuse' rows repeat a key already
  // handled at its source.
  const start = EXECUTE ? Number((await getState(SIBLING_PROGRESS_KEY)) ?? 0) : 0;
  if (start > 0) log(`  pass 2: resuming at page ${start}`);
  for (let page = start; page < pages; page += SIBLING_BATCH_PAGES) {
    const { rows } = await pool.query(`
      SELECT pubkey_hex, pubkey_exposed_at_block AS block FROM address_info
      WHERE ctid >= $1::tid AND ctid < $2::tid AND pubkey_exposed AND pubkey_hex IS NOT NULL
        AND exposure_kind IS DISTINCT FROM 'p2tr' AND exposure_kind IS DISTINCT FROM 'reuse'
    `, [`(${page},0)`, `(${page + SIBLING_BATCH_PAGES},0)`]);
    const hits: SiblingHit[] = [];
    for (const r of rows) match(r.pubkey_hex.split(','), r.block, hits);
    await apply(hits);
    if (EXECUTE) await setState(SIBLING_PROGRESS_KEY, String(page + SIBLING_BATCH_PAGES));
    if ((page / SIBLING_BATCH_PAGES) % 100 === 99 || page + SIBLING_BATCH_PAGES >= pages) {
      report(`pass 2: page ${Math.min(page + SIBLING_BATCH_PAGES, pages)}/${pages}`);
    }
  }
  if (EXECUTE) await setState(SIBLING_PROGRESS_KEY, '0');  // a re-run starts over
  log(`  done: ${tally.marked} sibling addresses ${EXECUTE ? 'marked' : 'would be marked'}, ${tally.funded} funded (${btc(tally.sats)} BTC)`);
}

// ---------------------------------------------------------------------------
// outkeys: Proposal 022, keys in spent P2PK / bare-multisig outputs
// ---------------------------------------------------------------------------

const OUTKEYS_PROGRESS_KEY = 'backfill_022_next_block';
const OUTPUT_KEY_TYPES = new Set(['pubkey', 'multisig']);

async function phaseOutkeys(): Promise<void> {
  log('phase outkeys: siblings of keys in every P2PK / bare-multisig output (022)');
  const from = Number(argValue('--from') ?? (await getState(OUTKEYS_PROGRESS_KEY)) ?? 0);
  const to = Number(argValue('--to') ?? (await getState('last_synced_block')) ?? 0);
  if (to < from) { log(`  nothing to do (from ${from} > to ${to})`); return; }
  log(`  blocks ${from}..${to}${EXECUTE ? '' : ' (dry run: counting only)'}`);

  const concurrency = Math.max(1, config.etl.concurrency);
  const tally = newTally();
  // A key seen once has had its siblings handled; most P2PK keys recur
  // (pool payouts, tribute), so skip repeats instead of re-querying them.
  const seen = new Set<string>();
  let keysSeen = 0;
  const t0 = Date.now();
  let lastReport = t0;

  for (let current = from; current <= to; ) {
    const batch: number[] = [];
    for (let i = 0; i < concurrency && current + i <= to; i++) batch.push(current + i);
    const hashes = await Promise.all(batch.map(h => getBlockHash(h)));
    const blocks = await Promise.all(hashes.map(h => getBlock(h, 2)));

    // Chain order, so the first hit per address carries the earliest block.
    const hits: SiblingHit[] = [];
    for (const block of blocks) {
      for (const tx of block.tx) {
        for (const vout of tx.vout) {
          if (!OUTPUT_KEY_TYPES.has(vout.scriptPubKey?.type)) continue;
          // On-curve keys only, and >= M of them for multisig: same test as 015 / 020.
          for (const k of exposedKeysInOutput(vout.scriptPubKey.hex)?.keys ?? []) {
            if (seen.has(k)) continue;
            seen.add(k);
            keysSeen++;
            for (const s of siblingAddresses(k)) hits.push({ ...s, block: block.height });
          }
        }
      }
    }
    await applySiblingHits(hits, tally);

    current += batch.length;
    if (EXECUTE) await setState(OUTKEYS_PROGRESS_KEY, String(current));

    const now = Date.now();
    if (now - lastReport > 60_000 || current > to) {
      const rate = (current - from) / ((now - t0) / 1000);
      const eta = rate > 0 ? Math.round((to - current) / rate / 60) : NaN;
      log(`  block ${current - 1}/${to} | keys ${keysSeen} | ${tallyLine(tally)} | eta ${eta}m`);
      lastReport = now;
    }
  }

  log(`  done: ${tally.marked} sibling addresses ${EXECUTE ? 'marked' : 'would be marked'}, ${tally.funded} funded (${btc(tally.sats)} BTC)`);
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// keyindex: revealed_key_hashes for every key already public
// ---------------------------------------------------------------------------

const KEYINDEX_PROGRESS_KEY = 'backfill_keyindex_next_page';
const KEYINDEX_BATCH_PAGES = 20_000;
const KEYINDEX_INSERT_ROWS = 50_000;
const BUILD_TABLE = 'revealed_key_hashes_build';

async function phaseKeyindex(): Promise<void> {
  log('phase keyindex: revealed_key_hashes from every public key (022 at receipt time)');
  const { rows: [{ pages }] } = await pool.query(
    `SELECT (pg_relation_size('address_info') / current_setting('block_size')::int)::int AS pages`
  );
  const start = EXECUTE ? Number((await getState(KEYINDEX_PROGRESS_KEY)) ?? 0) : 0;
  if (EXECUTE) {
    // No index while loading: one bulk build at the end is far cheaper.
    await pool.query(`CREATE TABLE IF NOT EXISTS ${BUILD_TABLE} (LIKE revealed_key_hashes INCLUDING DEFAULTS)`);
    if (start > 0) log(`  resuming at page ${start}`);
  }

  let total = 0;
  let pending: { h8: string; key: string; block: number }[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    if (EXECUTE) {
      await pool.query(`
        INSERT INTO ${BUILD_TABLE} (h8, key, block)
        SELECT h8, decode(key, 'hex'), block FROM unnest($1::bigint[], $2::text[], $3::int[]) AS v(h8, key, block)
      `, [pending.map(e => e.h8), pending.map(e => e.key), pending.map(e => e.block)]);
    }
    total += pending.length;
    pending = [];
  };
  const add = async (keys: string[], revealedAt: string | null, block: number) => {
    for (const k of keys) {
      for (const e of reverseIndexEntries(k, revealedAt)) pending.push({ h8: e.h8.toString(), key: e.key, block });
    }
    if (pending.length >= KEYINDEX_INSERT_ROWS) await flush();
  };

  // Keys revealed by spends (and legacy P2PK rows). Taproot keys have no
  // single-key siblings; 'reuse' rows repeat a key indexed at its source.
  for (let page = start; page < pages; page += KEYINDEX_BATCH_PAGES) {
    const { rows } = await pool.query(`
      SELECT address, pubkey_hex, pubkey_exposed_at_block AS block,
             COALESCE(exposure_kind, CASE WHEN is_p2pk THEN 'p2pk' ELSE 'pkh' END) AS kind
      FROM address_info
      WHERE ctid >= $1::tid AND ctid < $2::tid AND pubkey_exposed AND pubkey_hex IS NOT NULL
        AND exposure_kind IS DISTINCT FROM 'p2tr' AND exposure_kind IS DISTINCT FROM 'reuse'
    `, [`(${page},0)`, `(${page + KEYINDEX_BATCH_PAGES},0)`]);
    for (const r of rows) {
      await add(r.pubkey_hex.split(','), r.kind === 'pkh' ? r.address : null, Number(r.block ?? 0));
    }
    await flush();
    if (EXECUTE) await setState(KEYINDEX_PROGRESS_KEY, String(page + KEYINDEX_BATCH_PAGES));
    if ((page / KEYINDEX_BATCH_PAGES) % 100 === 99 || page + KEYINDEX_BATCH_PAGES >= pages) {
      log(`  address_info page ${Math.min(page + KEYINDEX_BATCH_PAGES, pages)}/${pages} | entries ${total}`);
    }
    // A dry run samples the first 2M pages and extrapolates.
    if (!EXECUTE && page + KEYINDEX_BATCH_PAGES >= 2_000_000) {
      const est = Math.round(total * pages / (page + KEYINDEX_BATCH_PAGES));
      log(`  dry run: ~${est} entries over the whole table (~${Math.round(est * 100 / 1e9)} GB with index)`);
      return;
    }
  }

  // Keys in output scripts (P2PK, bare multisig; 'nonstandard' covers
  // multisigs with a malformed cosigner), lost buckets included as in siblings.
  const { rows: inScript } = await pool.query(`
    SELECT script_hex, MIN(block_number) AS block FROM utxos
    WHERE script_type IN ('pubkey', 'multisig', 'nonstandard') AND loss_bucket IN (1, 4)
    GROUP BY script_hex
  `);
  for (const r of inScript) await add(exposedKeysInOutput(r.script_hex)?.keys ?? [], null, Number(r.block));
  await flush();
  log(`  output-script keys: ${inScript.length} scripts | entries ${total}`);

  log('  building index');
  const client = await pool.connect();
  try {
    await client.query(`SET maintenance_work_mem = '4GB'`);
    await client.query(`CREATE INDEX IF NOT EXISTS ${BUILD_TABLE}_h8 ON ${BUILD_TABLE} (h8)`);
    log('  swapping in');
    await client.query('BEGIN');
    // Blocks the ETL's inserts for the moment the swap takes; whatever it
    // added since the migration is carried over.
    await client.query('LOCK TABLE revealed_key_hashes IN EXCLUSIVE MODE');
    await client.query(`INSERT INTO ${BUILD_TABLE} SELECT * FROM revealed_key_hashes`);
    await client.query('DROP TABLE revealed_key_hashes');
    await client.query(`ALTER TABLE ${BUILD_TABLE} RENAME TO revealed_key_hashes`);
    await client.query(`ALTER INDEX ${BUILD_TABLE}_h8 RENAME TO idx_revealed_key_hashes_h8`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await pool.query('ANALYZE revealed_key_hashes');
  await setState(KEYINDEX_PROGRESS_KEY, '0');
  // From here the address page may say a key-free address was fully checked.
  await setState(KEYINDEX_BUILT_KEY, (await getState('last_synced_block')) ?? '0');
  log(`  done: ${total} entries`);
}

// ---------------------------------------------------------------------------
// hybrid: keys with an 06 / 07 prefix are spendable
// ---------------------------------------------------------------------------
async function phaseHybrid(): Promise<void> {
  log('phase hybrid: 005 / 006 outputs spendable with hybrid keys');
  const { rows } = await pool.query(`
    SELECT tx_hash, output_index, block_number, script_hex, value_sats::text, loss_rules
    FROM utxos WHERE loss_rules && '{005,006}'
  `);
  // exposedKeysInOutput applies the corrected key test: a row it now accepts
  // was only "lost" because of the hybrid encoding.
  const targets = rows
    .map(r => ({ ...r, exp: exposedKeysInOutput(r.script_hex) }))
    .filter(r => r.exp?.kind === 'p2pk' || r.exp?.kind === 'p2ms');
  const sats = targets.reduce((s, r) => s + BigInt(r.value_sats), 0n);
  log(`  ${rows.length} rows tagged 005 / 006, ${targets.length} spendable (${btc(sats)} BTC)`);
  for (const r of targets) log(`    ${r.tx_hash}:${r.output_index} block ${r.block_number}, ${btc(r.value_sats)} BTC, ${r.exp!.kind}`);
  if (!EXECUTE) return;
  for (const r of targets) {
    const rules = (r.loss_rules as RuleId[])
      .filter(x => x !== '005' && x !== '006')
      .concat(r.exp!.kind === 'p2pk' ? '015' : '020');
    const bucket = computeBucket(rules);
    await withDeadlockRetry(async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`
          UPDATE utxos SET loss_rules = $4::text[], loss_bucket = $5::smallint,
            pubkey_exposed = $5::smallint IN (0, 4), pubkey_hex = CASE WHEN $5::smallint IN (0, 4) THEN $6 END
          WHERE tx_hash = $1 AND output_index = $2 AND block_number = $3
        `, [r.tx_hash, r.output_index, r.block_number, rules, bucket, r.exp!.keys.join(',')]);
        await markSiblingAddresses(client, r.exp!.keys, Number(r.block_number));
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    });
  }
  log(`  retagged ${targets.length}`);
}

async function main() {
  log(`backfill-quantum-exposure: phases [${PHASES.join(', ')}] ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}`);
  const runners: Record<string, () => Promise<void>> = {
    fix: phaseFix, kinds: phaseKinds, receipts: phaseReceipts,
    p2tr: phaseP2tr, p2ms: phaseP2ms, scripts: phaseScripts, siblings: phaseSiblings, outkeys: phaseOutkeys,
    hybrid: phaseHybrid, keyindex: phaseKeyindex,
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
