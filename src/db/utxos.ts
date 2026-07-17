import { PoolClient } from 'pg';

export interface UtxoRecord {
  tx_hash: string;
  output_index: number;
  value_sats: bigint;
  block_number: number;
  block_timestamp: Date;
  script_hex: string;
  script_type: string | null;
  address: string | null;
  loss_rules: string[];
  loss_bucket: number;
  pubkey_exposed: boolean;
  pubkey_hex: string | null;
}

// Returns true only if a row was actually inserted. On a reprocessed block the
// ON CONFLICT fires and nothing is inserted (rowCount 0); the caller uses this
// to keep address_info in lockstep with the utxos table — see block-processor.
export async function insertUtxo(client: PoolClient, utxo: UtxoRecord): Promise<boolean> {
  const res = await client.query(`
    INSERT INTO utxos (tx_hash, output_index, value_sats, block_number, block_timestamp,
      script_hex, script_type, address, loss_rules, loss_bucket, pubkey_exposed, pubkey_hex)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (tx_hash, output_index, block_number) DO NOTHING
  `, [utxo.tx_hash, utxo.output_index, utxo.value_sats, utxo.block_number,
      utxo.block_timestamp, utxo.script_hex, utxo.script_type, utxo.address,
      utxo.loss_rules, utxo.loss_bucket, utxo.pubkey_exposed, utxo.pubkey_hex]);
  return (res.rowCount ?? 0) > 0;
}

// Returns true only if a row was actually deleted. A replayed spend finds the
// UTXO already gone (rowCount 0); the caller uses this to avoid decrementing
// address_info a second time.
export async function deleteUtxo(client: PoolClient, txHash: string, outputIndex: number): Promise<boolean> {
  const res = await client.query(
    'DELETE FROM utxos WHERE tx_hash = $1 AND output_index = $2',
    [txHash, outputIndex]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function markAddressPubkeyExposed(
  client: PoolClient, address: string, pubkeyHex: string
): Promise<void> {
  await client.query(`
    UPDATE utxos
    SET pubkey_exposed = TRUE,
        pubkey_hex = $2,
        loss_rules = CASE
          WHEN NOT (loss_rules @> '{016}') AND loss_bucket = 0 THEN array_append(loss_rules, '016')
          ELSE loss_rules
        END
    WHERE address = $1 AND pubkey_exposed = FALSE
  `, [address, pubkeyHex]);
}
