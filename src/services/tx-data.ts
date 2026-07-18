import { getRawTransaction } from './bitcoin-rpc.js';
import { getTip } from './tip.js';
import { localCache } from './local-cache.js';
import { config } from '../config.js';

// Read-through cache for confirmed raw transactions, saving the remote bitcoind
// RPC round-trip on repeat lookups. The raw tx is immutable; only its
// `confirmations` field changes each block, so that field is stripped before
// storing and recomputed on read from the current tip.
//
// Throws exactly like getRawTransaction when the tx doesn't exist, so callers
// keep their existing 404 handling. Only the RPC hop is cached — the tx page's
// separate utxos lookup (which of the outputs are still unspent) stays live,
// because that genuinely changes as outputs are spent.
export async function getCachedRawTransaction(txid: string): Promise<any> {
  const tip = await getTip();
  // The DB tip lags the chain by the confirmation lag; add it back to estimate
  // the chain tip. Using this same estimate at store and read time makes the
  // recomputed confirmations exactly track elapsed blocks, so any lag mismatch
  // cancels out.
  const chainTip = tip.height > 0 ? tip.height + config.etl.confirmationLag : 0;

  const hit = localCache.getTx(txid);
  if (hit) {
    const confirmations = chainTip > 0 ? Math.max(1, chainTip - hit.height + 1) : hit.raw.confirmations;
    return { ...hit.raw, confirmations };
  }

  const tx = await getRawTransaction(txid);
  const conf = tx.confirmations ?? 0;
  // Cache only once buried past the reorg window — a tx nearer the tip could
  // still be reorged out.
  if (conf >= config.cache.reorgDepth && chainTip > 0) {
    const height = chainTip - conf + 1;
    const { confirmations, ...immutable } = tx;
    void confirmations; // intentionally dropped; recomputed on read
    localCache.putTx(txid, immutable, height);
  }
  return tx;
}
