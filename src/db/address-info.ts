import { Pool, PoolClient } from 'pg';
import { pool } from './index.js';
import {
  siblingAddresses, forwardSiblings, addressPayload, isValidAddress, hashPrefix, reverseIndexEntries, keyControls,
  type ExposureKind,
} from '../classifiers/exposure.js';
import { markAddressPubkeyExposed as markUtxosPubkey } from './utxos.js';

export interface AddressExposure {
  pubkey_exposed: boolean;
  pubkey_hex: string | null;
  // Rows written before migration 008 have no kind; the only two the old ETL
  // could produce were P2PK and PKH, so the fallback is exact.
  exposure_kind: ExposureKind | null;
  is_new: boolean;  // this receipt created the row: the address's first coins
}

// Returns the address's exposure state when a UTXO was inserted (so the caller
// can flag a receipt at an already-exposed address), null on the spend path.
export async function upsertAddressInfo(
  client: PoolClient,
  address: string,
  blockNumber: number,
  isNewUtxo: boolean,
  valueSats: bigint
): Promise<AddressExposure | null> {
  if (isNewUtxo) {
    const { rows } = await client.query(`
      INSERT INTO address_info (address, first_seen_block, last_active_block, utxo_count, utxo_value_sats)
      VALUES ($1, $2, $2, 1, $3)
      ON CONFLICT (address) DO UPDATE SET
        last_active_block = GREATEST(address_info.last_active_block, EXCLUDED.last_active_block),
        utxo_count = address_info.utxo_count + 1,
        utxo_value_sats = address_info.utxo_value_sats + $3,
        updated_at = now()
      RETURNING pubkey_exposed, pubkey_hex,
        COALESCE(exposure_kind, CASE WHEN is_p2pk THEN 'p2pk' ELSE 'pkh' END) AS exposure_kind,
        (xmax = 0) AS is_new
    `, [address, blockNumber, valueSats]);
    const r = rows[0];
    return r
      ? { pubkey_exposed: r.pubkey_exposed, pubkey_hex: r.pubkey_hex, exposure_kind: r.exposure_kind, is_new: r.is_new }
      : null;
  } else {
    // spending — update last_active, decrement count
    await client.query(`
      UPDATE address_info SET
        last_active_block = GREATEST(last_active_block, $2),
        utxo_count = GREATEST(0, utxo_count - 1),
        utxo_value_sats = GREATEST(0, utxo_value_sats - $3),
        updated_at = now()
      WHERE address = $1
    `, [address, blockNumber, valueSats]);
    return null;
  }
}

// A spend revealed the address's key(s). First exposure wins: the same address
// always resolves to the same key or script, so a later spend adds nothing.
// Returns true only on that first exposure, so the caller can follow up once.
export async function markAddressPubkeyExposed(
  client: PoolClient,
  address: string,
  pubkeyHex: string,
  blockNumber: number,
  kind: ExposureKind
): Promise<boolean> {
  const res = await client.query(`
    UPDATE address_info
    SET pubkey_hex = $2, pubkey_exposed_at_block = $3, pubkey_exposed = TRUE,
        exposure_kind = COALESCE(exposure_kind, $4), updated_at = now()
    WHERE address = $1 AND pubkey_hex IS NULL
  `, [address, pubkeyHex, blockNumber, kind]);
  return (res.rowCount ?? 0) > 0;
}

// The address's output script carries its key(s) (P2PK, P2TR, bare multisig):
// exposed from the first receive. Idempotent, so it needs no insert gating.
export async function markAddressKeyInScript(
  client: PoolClient,
  address: string,
  kind: ExposureKind,
  pubkeyHex: string
): Promise<void> {
  await client.query(`
    UPDATE address_info
    SET pubkey_exposed = TRUE,
        is_p2pk = is_p2pk OR $2 = 'p2pk',
        exposure_kind = COALESCE(exposure_kind, $2),
        pubkey_hex = COALESCE(pubkey_hex, $3),
        updated_at = now()
    WHERE address = $1 AND (pubkey_exposed = FALSE OR exposure_kind IS NULL OR pubkey_hex IS NULL)
  `, [address, kind, pubkeyHex]);
}

// Proposal 022: the key(s) just became known, so every other single-key
// address they control is exposed too. Only addresses already in address_info
// are marked (an address first funded later is left to the backfill sweep);
// coins at the funded ones are flagged. The address where the key was seen is
// already marked, so `pubkey_hex IS NULL` skips it.
export async function markSiblingAddresses(
  client: PoolClient,
  keys: string[],
  blockNumber: number
): Promise<void> {
  const siblings = new Map<string, string>();
  for (const k of keys) for (const s of siblingAddresses(k)) siblings.set(s.address, s.key);
  if (siblings.size === 0) return;
  const { rows } = await client.query(`
    UPDATE address_info ai
    SET pubkey_hex = v.key, pubkey_exposed_at_block = $3, pubkey_exposed = TRUE,
        exposure_kind = COALESCE(ai.exposure_kind, 'reuse'), updated_at = now()
    FROM unnest($1::text[], $2::text[]) AS v(address, key)
    WHERE ai.address = v.address AND ai.pubkey_hex IS NULL
    RETURNING ai.address, ai.utxo_count, v.key
  `, [[...siblings.keys()], [...siblings.values()], blockNumber]);
  for (const r of rows) {
    if (Number(r.utxo_count) > 0) await markUtxosPubkey(client, r.address, r.key, '022');
  }
}

// Proposal 022 at receipt time, part 1: record the sibling hashes of newly
// public keys that the address side cannot derive (revealed_key_hashes).
// `revealedAt` is the single-key address whose spend revealed the key, or
// null for keys seen in a script or an output.
export async function indexRevealedKeys(
  client: PoolClient,
  items: { keys: string[]; revealedAt: string | null }[],
  blockNumber: number
): Promise<void> {
  const entries = new Map<string, { h8: string; key: string }>();
  for (const { keys, revealedAt } of items) {
    for (const k of keys) {
      for (const e of reverseIndexEntries(k, revealedAt)) entries.set(`${e.h8}:${e.key}`, { h8: e.h8.toString(), key: e.key });
    }
  }
  if (entries.size === 0) return;
  const es = [...entries.values()];
  await client.query(`
    INSERT INTO revealed_key_hashes (h8, key, block)
    SELECT v.h8, decode(v.key, 'hex'), $3
    FROM unnest($1::bigint[], $2::text[]) AS v(h8, key)
    WHERE NOT EXISTS (
      SELECT 1 FROM revealed_key_hashes r WHERE r.h8 = v.h8 AND r.key = decode(v.key, 'hex')
    )
  `, [es.map(e => e.h8), es.map(e => e.key), blockNumber]);
}

export interface KnownKey {
  key: string;
  block: number | null;  // when the key became public
  via: string | null;    // the sibling address that revealed it, if it was one
}

// Proposal 022 at receipt time, part 2: the public key, if any, that controls
// each address through a single-key template. Two lookups, both batched:
//   forward  the address's key-hash siblings (forwardSiblings) in address_info
//   reverse  its own HASH160 payload in revealed_key_hashes
// Every candidate key is re-hashed against the address before it counts.
// Together these cover every encoding and source of a public key, so an
// address with no match has no key on-chain as of the last indexed block.
export async function findKnownKeys(db: Pool | PoolClient, addresses: string[]): Promise<Map<string, KnownKey>> {
  const found = new Map<string, KnownKey>();
  const keep = (addr: string, k: KnownKey) => {
    const prev = found.get(addr);
    if (!prev || (k.block ?? Infinity) < (prev.block ?? Infinity)) found.set(addr, k);
  };

  const fwd = new Map<string, string[]>();  // sibling -> addresses it may unlock
  for (const a of addresses) for (const s of forwardSiblings(a)) fwd.set(s, [...(fwd.get(s) ?? []), a]);
  if (fwd.size) {
    const { rows } = await db.query(`
      SELECT address, pubkey_hex, pubkey_exposed_at_block FROM address_info
      WHERE address = ANY($1::text[]) AND pubkey_exposed AND pubkey_hex IS NOT NULL
    `, [[...fwd.keys()]]);
    for (const r of rows) {
      for (const a of fwd.get(r.address) ?? []) {
        const key = (r.pubkey_hex as string).split(',').find(k => keyControls(k, a));
        if (key) keep(a, { key, block: r.pubkey_exposed_at_block, via: r.address });
      }
    }
  }

  const byPrefix = new Map<string, string[]>();
  for (const a of addresses) {
    const p = addressPayload(a);
    if (!p) continue;
    const h8 = hashPrefix(p.payload).toString();
    byPrefix.set(h8, [...(byPrefix.get(h8) ?? []), a]);
  }
  if (byPrefix.size) {
    const { rows } = await db.query(`
      SELECT h8::text, encode(key, 'hex') AS key, block FROM revealed_key_hashes
      WHERE h8 = ANY($1::bigint[])
    `, [[...byPrefix.keys()]]);
    for (const r of rows) {
      for (const a of byPrefix.get(r.h8) ?? []) {
        if (keyControls(r.key, a)) keep(a, { key: r.key, block: r.block, via: null });
      }
    }
  }
  return found;
}

// Proposal 022 at receipt time, part 3: addresses that received their first
// coins this block, checked against every key already public. A key revealed
// after an address's first receipt is handled by markSiblingAddresses at the
// reveal, so between the two no sibling is missed.
export async function markReceivedSiblings(
  client: PoolClient,
  addresses: string[],
  blockNumber: number
): Promise<void> {
  if (addresses.length === 0) return;
  const known = await findKnownKeys(client, addresses);
  if (known.size === 0) return;
  const hits = [...known.entries()];
  const { rows } = await client.query(`
    UPDATE address_info ai
    SET pubkey_hex = v.key, pubkey_exposed_at_block = COALESCE(v.block, $4), pubkey_exposed = TRUE,
        exposure_kind = COALESCE(ai.exposure_kind, 'reuse'), updated_at = now()
    FROM unnest($1::text[], $2::text[], $3::int[]) AS v(address, key, block)
    WHERE ai.address = v.address AND ai.pubkey_hex IS NULL
    RETURNING ai.address, ai.utxo_count, v.key
  `, [hits.map(([a]) => a), hits.map(([, k]) => k.key), hits.map(([, k]) => k.block), blockNumber]);
  for (const r of rows) {
    if (Number(r.utxo_count) > 0) await markUtxosPubkey(client, r.address, r.key, '022');
  }
}

// etl_state key set by `--phase keyindex` once revealed_key_hashes covers all
// history; until then a "no key found" answer cannot claim full coverage.
export const KEYINDEX_BUILT_KEY = 'revealed_key_hashes_built_at';

export interface QuantumStatus {
  valid: boolean;              // false: not a valid address (checksum, typo)
  exposed: boolean;
  kind: ExposureKind | null;
  keys: string[];
  block: number | null;        // when the key became public
  via: string | null;          // for 'reuse': the sibling address that revealed it
  recorded: boolean;           // false: found by the live lookup, not yet in address_info
  // For an address with no known key: what the check covered.
  singleKeyType: 'p2pkh' | 'p2wpkh' | 'p2sh' | null;
  fullCoverage: boolean;       // revealed_key_hashes is complete
  asOfBlock: number | null;
}

// Everything the site knows about whether an address's key is public, for the
// address page and API. An address need not be funded or even seen: checking
// one before sending coins to it is the point.
export async function addressQuantumStatus(addr: string, addrInfo: any | null): Promise<QuantumStatus> {
  const { rows: st } = await pool.query(
    `SELECT key, value FROM etl_state WHERE key IN ('last_synced_block', $1)`, [KEYINDEX_BUILT_KEY]
  );
  const state = Object.fromEntries(st.map(r => [r.key, r.value]));
  const base = {
    valid: isValidAddress(addr),
    singleKeyType: addressPayload(addr)?.type ?? null,
    fullCoverage: state[KEYINDEX_BUILT_KEY] != null,
    asOfBlock: state['last_synced_block'] != null ? Number(state['last_synced_block']) : null,
  };

  if (!base.valid) {
    return { ...base, exposed: false, kind: null, keys: [], block: null, via: null, recorded: false };
  }
  if (addrInfo?.pubkey_exposed) {
    const kind: ExposureKind = addrInfo.exposure_kind ?? (addrInfo.is_p2pk ? 'p2pk' : 'pkh');
    let via: string | null = null;
    if (kind === 'reuse') via = (await findKnownKeys(pool, [addr])).get(addr)?.via ?? null;
    return {
      ...base, exposed: true, kind, via, recorded: true,
      keys: addrInfo.pubkey_hex ? String(addrInfo.pubkey_hex).split(',') : [],
      block: addrInfo.pubkey_exposed_at_block != null ? Number(addrInfo.pubkey_exposed_at_block) : null,
    };
  }
  // A taproot address is its output key: public before it is ever funded.
  if (/^bc1p[02-9ac-hj-np-z]{58}$/.test(addr)) {
    return { ...base, exposed: true, kind: 'p2tr', keys: [], block: null, via: null, recorded: false };
  }
  const k = (await findKnownKeys(pool, [addr])).get(addr);
  if (k) {
    return { ...base, exposed: true, kind: 'reuse', keys: [k.key], block: k.block, via: k.via, recorded: false };
  }
  return { ...base, exposed: false, kind: null, keys: [], block: null, via: null, recorded: false };
}
