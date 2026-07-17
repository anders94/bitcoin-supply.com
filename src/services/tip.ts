import { pool } from '../db/index.js';
import { cacheGet, cacheSet } from './redis.js';

export interface Tip {
  height: number;
  timestamp: string;
}

const TIP_KEY = 'tip';
const TIP_TTL = 30;

const ZERO_TIP: Tip = { height: 0, timestamp: new Date(0).toISOString() };

async function readTipFromDb(): Promise<Tip> {
  const { rows } = await pool.query(
    'SELECT block_number, block_timestamp FROM blocks ORDER BY block_number DESC LIMIT 1'
  );
  return rows[0]
    ? { height: Number(rows[0].block_number), timestamp: new Date(rows[0].block_timestamp).toISOString() }
    : ZERO_TIP;
}

// Reads straight through to Postgres and refreshes the cache. The block poller
// (services/sse.ts) calls this on its own schedule — it must not read the cache
// it is trying to keep fresh, or it would compare against a value up to TTL
// seconds old and only notice a block ~45s late instead of ~15s.
//
// Throws on a database error, so the poller can log and skip rather than
// broadcasting a zero tip and blanking every client's header.
export async function refreshTip(): Promise<Tip> {
  const tip = await readTipFromDb();
  cacheSet(TIP_KEY, JSON.stringify(tip), TIP_TTL).catch(() => { /* non-fatal */ });
  return tip;
}

// The chain tip for rendering. Every page puts it in the header, so this once
// ran against Postgres on every single request — including the 404s that bot
// URL scanning generates by the thousand. One Redis key, so no cardinality
// risk. In practice the poller keeps this warm and it is always a cache hit;
// if the poller dies, the TTL lapses and this falls back to the query.
//
// Never throws: a broken tip should degrade the header, not the page.
export async function getTip(): Promise<Tip> {
  try {
    const cached = await cacheGet(TIP_KEY);
    if (cached) return JSON.parse(cached) as Tip;
  } catch { /* redis down — fall through to the database */ }

  try {
    return await refreshTip();
  } catch {
    return ZERO_TIP;
  }
}
