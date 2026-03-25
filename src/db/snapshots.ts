import { pool } from './index.js';

export interface Snapshot {
  snapshot_key: string;
  total_sats: bigint;
  utxo_count: bigint;
  computed_at_block: number;
}

export async function upsertSnapshot(snap: Snapshot): Promise<void> {
  await pool.query(`
    INSERT INTO loss_snapshots (snapshot_key, total_sats, utxo_count, computed_at_block, computed_at)
    VALUES ($1, $2, $3, $4, now())
    ON CONFLICT (snapshot_key) DO UPDATE SET
      total_sats = $2, utxo_count = $3, computed_at_block = $4, computed_at = now()
  `, [snap.snapshot_key, snap.total_sats, snap.utxo_count, snap.computed_at_block]);
}

export async function getSnapshot(key: string): Promise<Snapshot | null> {
  const { rows } = await pool.query(
    'SELECT * FROM loss_snapshots WHERE snapshot_key = $1', [key]
  );
  return rows[0] || null;
}

export async function getAllSnapshots(): Promise<Record<string, Snapshot>> {
  const { rows } = await pool.query('SELECT * FROM loss_snapshots');
  const result: Record<string, Snapshot> = {};
  for (const row of rows) result[row.snapshot_key] = row;
  return result;
}
