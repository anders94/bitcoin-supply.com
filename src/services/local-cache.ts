import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

// Local on-disk read-through cache for IMMUTABLE data only: confirmed block
// metadata + its loss rows, and confirmed raw transactions. Everything mutable
// (addresses, the live UTXO set, confirmation counts) is fetched live and never
// stored here.
//
// Design invariant: the cache can never make a response wrong, only faster.
// Every method is wrapped so that a missing node:sqlite runtime, a corrupt
// file, or any query error degrades to a miss/no-op and the caller falls back
// to the remote source. Nothing here ever throws to a caller.
//
// node:sqlite is experimental and (in @types/node 20) untyped, so it is loaded
// through a guarded require and treated as `any`.
let sqlite: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sqlite = require('node:sqlite');
} catch { /* older runtime without node:sqlite — cache stays disabled */ }

export interface CachedBlock {
  block: any;
  lossOutputs: any[];
  lossSats: string;
  lossCount: number;
  pager: { prev: number | null; next: number | null };
}

export interface CachedTx {
  raw: any;      // getRawTransaction output, minus the volatile confirmations field
  height: number; // block height, so confirmations can be recomputed from the tip
}

// How often (in tx inserts) to check the on-disk size against the budget. The
// check is a cheap header read, so this is frequent; the expensive prune only
// runs when actually over budget.
const PRUNE_CHECK_INTERVAL = 2000;
// Rows deleted per prune iteration before re-measuring. ~2000 rows ≈ tens of MB.
const PRUNE_BATCH = 2000;
// Prune down to this fraction of the budget so a steady trickle of inserts
// doesn't re-trigger a prune on every batch (hysteresis / low-water mark).
const PRUNE_LOW_WATER = 0.9;

class LocalCache {
  private db: any = null;
  private enabled = false;
  private putBlockStmt: any = null;
  private getBlockStmt: any = null;
  private putTxStmt: any = null;
  private getTxStmt: any = null;
  private txPruneStmt: any = null;
  private pageCountStmt: any = null;
  private pageSize = 4096;
  private txInserts = 0;

  init(): void {
    if (!config.cache.enabled) { console.log('local cache: disabled by config'); return; }
    if (!sqlite?.DatabaseSync) { console.log('local cache: node:sqlite unavailable, disabled'); return; }
    try {
      mkdirSync(config.cache.dir, { recursive: true });
      const file = path.join(config.cache.dir, 'cache.sqlite');
      this.db = new sqlite.DatabaseSync(file);
      // INCREMENTAL auto-vacuum lets pruning return freed pages to the OS via
      // `PRAGMA incremental_vacuum`, so the file actually shrinks — no blocking
      // full VACUUM (which would need a second copy of the DB in free space).
      // This only takes effect on a fresh DB; flipping it on an existing file
      // requires a one-time VACUUM, so a legacy cache should be deleted (it is
      // read-through and repopulates) rather than migrated in place.
      this.db.exec('PRAGMA auto_vacuum = INCREMENTAL');
      // WAL lets readers and the writer proceed concurrently; NORMAL sync is
      // safe for a cache (a crash can at worst lose recent cache entries, which
      // just re-populate from remote).
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS block_cache (
          height     INTEGER PRIMARY KEY,
          block      TEXT NOT NULL,
          losses     TEXT NOT NULL,
          loss_sats  TEXT NOT NULL,
          loss_count INTEGER NOT NULL,
          pager      TEXT NOT NULL,
          cached_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tx_cache (
          txid      TEXT PRIMARY KEY,
          raw       TEXT NOT NULL,
          height    INTEGER NOT NULL,
          cached_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS tx_cache_cached_at ON tx_cache(cached_at);
      `);
      this.putBlockStmt = this.db.prepare(
        `INSERT INTO block_cache (height, block, losses, loss_sats, loss_count, pager, cached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(height) DO NOTHING`);
      this.getBlockStmt = this.db.prepare('SELECT * FROM block_cache WHERE height = ?');
      this.putTxStmt = this.db.prepare(
        `INSERT INTO tx_cache (txid, raw, height, cached_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(txid) DO NOTHING`);
      this.getTxStmt = this.db.prepare('SELECT raw, height FROM tx_cache WHERE txid = ?');
      // Delete the oldest N cached txs (by cached_at) — one prune iteration.
      this.txPruneStmt = this.db.prepare(
        `DELETE FROM tx_cache WHERE txid IN (
           SELECT txid FROM tx_cache ORDER BY cached_at ASC LIMIT ?)`);
      this.pageCountStmt = this.db.prepare('PRAGMA page_count');
      this.pageSize = this.db.prepare('PRAGMA page_size').get().page_size || 4096;
      this.enabled = true;
      const budgetGb = (config.cache.maxBytes / 1024 ** 3).toFixed(1);
      console.log(`local cache: ${file} (reorg depth ${config.cache.reorgDepth}, budget ${budgetGb} GiB)`);
    } catch (err) {
      console.error('local cache disabled:', (err as Error).message);
      this.enabled = false;
      this.db = null;
    }
  }

  getBlock(height: number): CachedBlock | null {
    if (!this.enabled) return null;
    try {
      const row = this.getBlockStmt.get(height);
      if (!row) return null;
      return {
        block: JSON.parse(row.block),
        lossOutputs: JSON.parse(row.losses),
        lossSats: row.loss_sats,
        lossCount: row.loss_count,
        pager: JSON.parse(row.pager),
      };
    } catch { return null; }
  }

  putBlock(height: number, data: CachedBlock): void {
    if (!this.enabled) return;
    try {
      this.putBlockStmt.run(
        height, JSON.stringify(data.block), JSON.stringify(data.lossOutputs),
        data.lossSats, data.lossCount, JSON.stringify(data.pager), Date.now());
    } catch { /* non-fatal */ }
  }

  getTx(txid: string): CachedTx | null {
    if (!this.enabled) return null;
    try {
      const row = this.getTxStmt.get(txid);
      if (!row) return null;
      return { raw: JSON.parse(row.raw), height: row.height };
    } catch { return null; }
  }

  putTx(txid: string, raw: any, height: number): void {
    if (!this.enabled) return;
    try {
      const serialized = JSON.stringify(raw);
      // Skip pathologically large txs: they'd dominate the cache while being too
      // rare for the hit to matter. Re-fetching them from remote stays correct.
      if (serialized.length > config.cache.maxTxBytes) return;
      this.putTxStmt.run(txid, serialized, height, Date.now());
      // Amortized: the size probe is a cheap header read, so check often, but
      // only run the (heavier) prune loop when actually over budget.
      if (++this.txInserts % PRUNE_CHECK_INTERVAL === 0 && this.fileBytes() > config.cache.maxBytes) {
        this.prune();
      }
    } catch { /* non-fatal */ }
  }

  // Current on-disk size of the sqlite file, from its page count. Cheap enough
  // to poll — it reads the DB header, not the data.
  private fileBytes(): number {
    return this.pageCountStmt.get().page_count * this.pageSize;
  }

  // Evict oldest txs until the file is back under the low-water mark, returning
  // freed pages to the OS after each batch. Bounded by a guard so a DB that
  // can't shrink (e.g. auto_vacuum disabled on a legacy file) can't spin.
  private prune(): void {
    const target = config.cache.maxBytes * PRUNE_LOW_WATER;
    const before = this.fileBytes();
    let guard = 0;
    while (this.fileBytes() > target && guard++ < 10000) {
      const deleted = this.txPruneStmt.run(PRUNE_BATCH).changes;
      // Return the freed pages to the OS so the file physically shrinks.
      this.db.exec('PRAGMA incremental_vacuum');
      if (!deleted) break; // nothing left to evict
    }
    const mb = (n: number) => (n / 1024 ** 2).toFixed(0);
    console.log(`local cache: pruned ${mb(before)} MiB -> ${mb(this.fileBytes())} MiB`);
  }
}

export const localCache = new LocalCache();
