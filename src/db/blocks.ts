import { PoolClient } from 'pg';

export interface BlockRecord {
  block_number: number;
  block_hash: string;
  block_timestamp: Date;
  tx_count: number;
  coinbase_value_sats: bigint;
  allowed_supply_sats: bigint;
  miner_loss_sats: bigint;
}

export async function upsertBlock(client: PoolClient, block: BlockRecord): Promise<void> {
  await client.query(`
    INSERT INTO blocks (block_number, block_hash, block_timestamp, tx_count,
      coinbase_value_sats, allowed_supply_sats, miner_loss_sats)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (block_number) DO UPDATE SET
      block_hash = EXCLUDED.block_hash,
      coinbase_value_sats = EXCLUDED.coinbase_value_sats,
      allowed_supply_sats = EXCLUDED.allowed_supply_sats,
      miner_loss_sats = EXCLUDED.miner_loss_sats
  `, [block.block_number, block.block_hash, block.block_timestamp, block.tx_count,
      block.coinbase_value_sats, block.allowed_supply_sats, block.miner_loss_sats]);
}

export async function getLatestBlock(client: PoolClient): Promise<number> {
  const { rows } = await client.query('SELECT MAX(block_number) as n FROM blocks');
  return rows[0].n ?? -1;
}
