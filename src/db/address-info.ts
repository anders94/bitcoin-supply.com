import { PoolClient } from 'pg';

export async function upsertAddressInfo(
  client: PoolClient,
  address: string,
  blockNumber: number,
  isNewUtxo: boolean,
  valueSats: bigint
): Promise<void> {
  if (isNewUtxo) {
    await client.query(`
      INSERT INTO address_info (address, first_seen_block, last_active_block, utxo_count, utxo_value_sats)
      VALUES ($1, $2, $2, 1, $3)
      ON CONFLICT (address) DO UPDATE SET
        last_active_block = GREATEST(address_info.last_active_block, EXCLUDED.last_active_block),
        utxo_count = address_info.utxo_count + 1,
        utxo_value_sats = address_info.utxo_value_sats + $3,
        updated_at = now()
    `, [address, blockNumber, valueSats]);
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
  }
}

export async function markAddressPubkeyExposed(
  client: PoolClient,
  address: string,
  pubkeyHex: string,
  blockNumber: number
): Promise<void> {
  await client.query(`
    UPDATE address_info
    SET pubkey_hex = $2, pubkey_exposed_at_block = $3, pubkey_exposed = TRUE, updated_at = now()
    WHERE address = $1 AND pubkey_hex IS NULL
  `, [address, pubkeyHex, blockNumber]);
}

export async function markAddressP2PKExposed(
  client: PoolClient,
  address: string
): Promise<void> {
  await client.query(`
    UPDATE address_info
    SET pubkey_exposed = TRUE, is_p2pk = TRUE, updated_at = now()
    WHERE address = $1
  `, [address]);
}
