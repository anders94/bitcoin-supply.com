import { pool } from './index.js';

export interface ComputedStat {
  key: string;
  data: any;
  computed_at_block: number;
  computed_at: Date;
}

export async function upsertComputedStat(key: string, data: object, block: number): Promise<void> {
  await pool.query(`
    INSERT INTO computed_stats (key, data, computed_at_block, computed_at)
    VALUES ($1, $2, $3, now())
    ON CONFLICT (key) DO UPDATE SET
      data = $2, computed_at_block = $3, computed_at = now()
  `, [key, JSON.stringify(data), block]);
}

export async function getComputedStats(keys: string[]): Promise<Record<string, ComputedStat>> {
  const { rows } = await pool.query(
    'SELECT key, data, computed_at_block, computed_at FROM computed_stats WHERE key = ANY($1)',
    [keys]
  );
  const result: Record<string, ComputedStat> = {};
  for (const row of rows) result[row.key] = row;
  return result;
}
