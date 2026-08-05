import { mkdirSync, rmSync } from 'node:fs';
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
// Stop a single prune pass after this long. Evicting tens of GiB in one pass
// would block the event loop for minutes, since node:sqlite is synchronous; the
// next size check resumes where this one stopped.
const PRUNE_TIME_BUDGET_MS = 2000;
// If this many consecutive passes fail to shrink the file, eviction is not
// working at all (a corrupt b-tree, or auto_vacuum off on a legacy file) and no
// amount of further pruning will help — rebuild instead of growing forever.
const PRUNE_FUTILE_LIMIT = 3;

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
  private futilePrunes = 0;
  private rebuilding = false;

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
      // A file left oversized by a previous run shouldn't have to wait for
      // PRUNE_CHECK_INTERVAL inserts to be noticed — and if it turns out to be
      // unprunable, boot is the right time to find out and rebuild.
      if (this.fileBytes() > config.cache.maxBytes) this.prune();
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
      if (serialized.length <= config.cache.maxTxBytes) {
        this.putTxStmt.run(txid, serialized, height, Date.now());
      }
    } catch { /* non-fatal */ }
    this.maybePrune();
  }

  // Amortized size check: the probe is a cheap header read, so check often, but
  // only run the (heavier) prune loop when actually over budget.
  //
  // Deliberately outside putTx's catch. Folding the check into that try meant a
  // throwing insert also skipped the size check, and a throwing prune was
  // swallowed as "non-fatal" — so a cache that could no longer evict grew past
  // its budget silently, with nothing in the log to say so.
  private maybePrune(): void {
    if (!this.enabled) return;
    if (++this.txInserts % PRUNE_CHECK_INTERVAL !== 0) return;
    try {
      if (this.fileBytes() > config.cache.maxBytes) this.prune();
    } catch (err) {
      console.error('local cache: size check failed:', (err as Error).message);
    }
  }

  // Current on-disk size of the sqlite file, from its page count. Cheap enough
  // to poll — it reads the DB header, not the data.
  private fileBytes(): number {
    return this.pageCountStmt.get().page_count * this.pageSize;
  }

  // Evict oldest txs until the file is back under the low-water mark, returning
  // freed pages to the OS after each batch. Time-boxed rather than unbounded:
  // a pass that has to shed tens of GiB would otherwise stall every request for
  // the duration, and the next size check resumes the work anyway.
  private prune(): void {
    const target = config.cache.maxBytes * PRUNE_LOW_WATER;
    const before = this.fileBytes();
    const deadline = Date.now() + PRUNE_TIME_BUDGET_MS;
    try {
      while (this.fileBytes() > target && Date.now() < deadline) {
        const deleted = this.txPruneStmt.run(PRUNE_BATCH).changes;
        // Return the freed pages to the OS so the file physically shrinks.
        this.db.exec('PRAGMA incremental_vacuum');
        if (!deleted) break; // nothing left to evict
      }
    } catch (err) {
      // A single corrupt page in tx_cache makes every DELETE that walks it fail
      // like this, which leaves the cache unable to evict anything at all.
      console.error('local cache: prune failed:', (err as Error).message);
      this.rebuild();
      return;
    }
    const after = this.fileBytes();
    const mb = (n: number) => (n / 1024 ** 2).toFixed(0);
    console.log(`local cache: pruned ${mb(before)} MiB -> ${mb(after)} MiB (budget ${mb(config.cache.maxBytes)} MiB)`);
    // Still over budget having freed nothing: either the table is empty and the
    // space is unreclaimable, or the file simply can't shrink. Give it a couple
    // of passes to rule out a fluke, then start over.
    if (after > target && after >= before) {
      if (++this.futilePrunes >= PRUNE_FUTILE_LIMIT) {
        console.error(`local cache: ${PRUNE_FUTILE_LIMIT} prune passes freed nothing`);
        this.rebuild();
      }
    } else {
      this.futilePrunes = 0;
    }
  }

  // Last resort for a cache that can't be pruned: delete the file and start
  // clean. Always safe — the cache is read-through, so the only cost is
  // re-fetching from the remote source until it warms back up.
  private rebuild(): void {
    if (this.rebuilding) return; // init() prunes, and prune() can land back here
    this.rebuilding = true;
    try {
      const file = path.join(config.cache.dir, 'cache.sqlite');
      console.error(`local cache: rebuilding ${file}`);
      this.enabled = false;
      this.putBlockStmt = this.getBlockStmt = this.putTxStmt = null;
      this.getTxStmt = this.txPruneStmt = this.pageCountStmt = null;
      try {
        this.db?.close();
      } catch (err) {
        // Unlinking a file we still hold open would free no space until the
        // process exits, and the replacement would grow alongside it. Stay
        // disabled and let a restart clear it instead.
        console.error('local cache: close failed, disabled until restart:', (err as Error).message);
        this.db = null;
        return;
      }
      this.db = null;
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          rmSync(file + suffix, { force: true });
        } catch (err) {
          console.error(`local cache: cannot remove ${file}${suffix}, disabled:`, (err as Error).message);
          return;
        }
      }
      this.txInserts = 0;
      this.futilePrunes = 0;
      this.init();
    } finally {
      this.rebuilding = false;
    }
  }
}

export const localCache = new LocalCache();
