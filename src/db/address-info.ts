import { PoolClient } from 'pg';
import { siblingAddresses, type ExposureKind } from '../classifiers/exposure.js';
import { markAddressPubkeyExposed as markUtxosPubkey } from './utxos.js';

export interface AddressExposure {
  pubkey_exposed: boolean;
  pubkey_hex: string | null;
  // Rows written before migration 008 have no kind; the only two the old ETL
  // could produce were P2PK and PKH, so the fallback is exact.
  exposure_kind: ExposureKind | null;
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
        COALESCE(exposure_kind, CASE WHEN is_p2pk THEN 'p2pk' ELSE 'pkh' END) AS exposure_kind
    `, [address, blockNumber, valueSats]);
    const r = rows[0];
    return r
      ? { pubkey_exposed: r.pubkey_exposed, pubkey_hex: r.pubkey_hex, exposure_kind: r.exposure_kind }
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
