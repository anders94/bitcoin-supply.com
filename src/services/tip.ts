import { pool } from '../db/index.js';
import { cacheGet, cacheSet } from './redis.js';

export interface Tip {
  height: number;
  timestamp: string;
}

const TIP_KEY = 'tip';
const TIP_TTL = 30;

// The chain tip, cached. Every page renders it in the header, so this once ran
// against Postgres on every single request — including the 404s that bot URL
// scanning generates by the thousand. One Redis key, so there is no cardinality
// risk, and blocks only arrive every ~11 minutes anyway.
//
// A Redis outage falls back to the query rather than to a zero tip.
export async function getTip(): Promise<Tip> {
  try {
    const cached = await cacheGet(TIP_KEY);
    if (cached) return JSON.parse(cached) as Tip;
  } catch { /* redis down — fall through to the database */ }

  try {
    const { rows } = await pool.query(
      'SELECT block_number, block_timestamp FROM blocks ORDER BY block_number DESC LIMIT 1'
    );
    const tip: Tip = rows[0]
      ? { height: Number(rows[0].block_number), timestamp: new Date(rows[0].block_timestamp).toISOString() }
      : { height: 0, timestamp: new Date(0).toISOString() };
    cacheSet(TIP_KEY, JSON.stringify(tip), TIP_TTL).catch(() => { /* non-fatal */ });
    return tip;
  } catch {
    return { height: 0, timestamp: new Date(0).toISOString() };
  }
}
