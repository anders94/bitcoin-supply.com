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

class LocalCache {
  private db: any = null;
  private enabled = false;
  private putBlockStmt: any = null;
  private getBlockStmt: any = null;
  private putTxStmt: any = null;
  private getTxStmt: any = null;
  private txPruneStmt: any = null;
  private txInserts = 0;

  init(): void {
    if (!config.cache.enabled) { console.log('local cache: disabled by config'); return; }
    if (!sqlite?.DatabaseSync) { console.log('local cache: node:sqlite unavailable, disabled'); return; }
    try {
      mkdirSync(config.cache.dir, { recursive: true });
      const file = path.join(config.cache.dir, 'cache.sqlite');
      this.db = new sqlite.DatabaseSync(file);
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
      // Prune to the newest maxTxRows by cached_at when over budget.
      this.txPruneStmt = this.db.prepare(
        `DELETE FROM tx_cache WHERE txid IN (
           SELECT txid FROM tx_cache ORDER BY cached_at DESC LIMIT -1 OFFSET ?)`);
      this.enabled = true;
      console.log(`local cache: ${file} (reorg depth ${config.cache.reorgDepth})`);
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
      this.putTxStmt.run(txid, JSON.stringify(raw), height, Date.now());
      // Amortized pruning: only check periodically, not every insert.
      if (++this.txInserts % 5000 === 0) {
        this.txPruneStmt.run(config.cache.maxTxRows);
      }
    } catch { /* non-fatal */ }
  }
}

export const localCache = new LocalCache();
