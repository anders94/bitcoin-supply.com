import { pool } from '../db/index.js';
import { getTip } from './tip.js';
import { localCache, CachedBlock } from './local-cache.js';
import { config } from '../config.js';

// Read-through loader for a block's immutable data, shared by the HTML page and
// the JSON API. On a cache hit it does zero network round-trips; on a miss it
// runs the same queries the routes used to run inline, then caches the result
// if the block is buried past the reorg window. Returns null if the block is
// not indexed (the caller renders a 404).
export async function loadBlock(blockNum: number): Promise<CachedBlock | null> {
  const hit = localCache.getBlock(blockNum);
  if (hit) return hit;

  const { rows: blockRows } = await pool.query('SELECT * FROM blocks WHERE block_number = $1', [blockNum]);
  if (!blockRows.length) return null;
  const block = blockRows[0];
  // Normalize so the cache and remote paths return the same shape (JSON can't
  // carry a Date; the format helpers accept the ISO string either way).
  block.block_timestamp = new Date(block.block_timestamp).toISOString();

  const { rows: lossOutputs } = await pool.query(`
    SELECT tx_hash, output_index, value_sats, loss_rules, loss_bucket
    FROM utxos WHERE loss_bucket IN (1, 2) AND block_number = $1
    ORDER BY value_sats DESC LIMIT 100
  `, [blockNum]);

  const { rows: sumRows } = await pool.query(`
    SELECT COALESCE(SUM(value_sats), 0) AS total, COUNT(*) AS n FROM utxos
    WHERE loss_bucket IN (1, 2) AND block_number = $1
  `, [blockNum]);

  // Nearest block in each direction that removed coin — for the page's pager.
  const { rows: pagerRows } = await pool.query(`
    SELECT
      GREATEST(
        (SELECT MAX(block_number) FROM utxos  WHERE loss_bucket IN (1, 2) AND block_number < $1),
        (SELECT MAX(block_number) FROM blocks WHERE miner_loss_sats > 0   AND block_number < $1)
      ) AS prev_loss,
      LEAST(
        (SELECT MIN(block_number) FROM utxos  WHERE loss_bucket IN (1, 2) AND block_number > $1),
        (SELECT MIN(block_number) FROM blocks WHERE miner_loss_sats > 0   AND block_number > $1)
      ) AS next_loss
  `, [blockNum]);
  const prev = pagerRows[0].prev_loss != null ? Number(pagerRows[0].prev_loss) : null;
  const next = pagerRows[0].next_loss != null ? Number(pagerRows[0].next_loss) : null;

  const data: CachedBlock = {
    block,
    lossOutputs: lossOutputs.map((u: any) => ({ ...u, value_sats: String(u.value_sats) })),
    lossSats: String(sumRows[0].total),
    lossCount: Number(sumRows[0].n),
    pager: { prev, next },
  };

  // Cache only if the block is final. Two guards: the block itself must be
  // buried past the reorg window, and so must its `next` pager pointer — that
  // points at a neighbour which, if inside the window, could still be reorged
  // and would make the cached pager stale.
  const tip = await getTip();
  const safeHeight = tip.height - config.cache.reorgDepth;
  if (tip.height > 0 && blockNum <= safeHeight && (next == null || next <= safeHeight)) {
    localCache.putBlock(blockNum, data);
  }
  return data;
}
