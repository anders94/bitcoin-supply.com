import { getBlockHash, getBlock, getBlockCount } from '../services/bitcoin-rpc.js';
import { processBlock } from './block-processor.js';
import { loadNumsMatcher } from '../classifiers/nums.js';
import { pool } from '../db/index.js';
import { config } from '../config.js';

async function loadKnownBurnAddresses(): Promise<Set<string>> {
  const { rows } = await pool.query('SELECT address FROM known_burn_addresses');
  return new Set(rows.map((r: any) => r.address));
}

export async function getLastSyncedBlock(): Promise<number> {
  const { rows } = await pool.query("SELECT value FROM etl_state WHERE key = 'last_synced_block'");
  return parseInt(rows[0]?.value ?? '-1');
}

export async function setLastSyncedBlock(n: number): Promise<void> {
  await pool.query(
    "UPDATE etl_state SET value = $1, updated_at = now() WHERE key = 'last_synced_block'",
    [n.toString()]
  );
}

export async function runHistoricalSync(startBlock?: number): Promise<void> {
  const knownBurnAddresses = await loadKnownBurnAddresses();
  const numsMatcher = await loadNumsMatcher(pool);
  const lastSynced = startBlock ?? await getLastSyncedBlock();
  const tipBlock = await getBlockCount() - config.etl.confirmationLag;

  if (tipBlock < 0) {
    console.log('Not enough blocks to satisfy confirmation lag. Nothing to sync.');
    return;
  }

  console.log(`Historical sync: blocks ${lastSynced + 1} to ${tipBlock} (lag: ${config.etl.confirmationLag})`);

  const concurrency = config.etl.concurrency;
  let current = lastSynced + 1;

  const syncStart = Date.now();
  let totalTxProcessed = 0;
  let lastReportTime = syncStart;
  let lastReportTx = 0;
  let lastReportBlock = lastSynced;
  const REPORT_INTERVAL_MS = 5 * 60 * 1000;

  while (current <= tipBlock) {
    // Process a batch of blocks in parallel
    const batch: number[] = [];
    for (let i = 0; i < concurrency && current + i <= tipBlock; i++) {
      batch.push(current + i);
    }

    // Fetch all block hashes in parallel
    const hashes = await Promise.all(batch.map(h => getBlockHash(h)));

    // Fetch all blocks in parallel
    const blocks = await Promise.all(hashes.map(h => getBlock(h)));

    // Process sequentially (maintain UTXO consistency)
    for (const block of blocks) {
      await processBlock(block, knownBurnAddresses, numsMatcher);
      totalTxProcessed += block.tx.length;

      const now = Date.now();
      if (now - lastReportTime >= REPORT_INTERVAL_MS) {
        const intervalSecs = (now - lastReportTime) / 1000;
        const intervalTx = totalTxProcessed - lastReportTx;
        const intervalBlocks = block.height - lastReportBlock;
        const txPerSec = (intervalTx / intervalSecs).toFixed(1);
        const txPerBlock = intervalBlocks > 0 ? (intervalTx / intervalBlocks).toFixed(1) : '?';
        const blocksRemaining = tipBlock - block.height;
        const blocksPerSec = intervalBlocks / intervalSecs;
        const etaSecs = blocksPerSec > 0 ? blocksRemaining / blocksPerSec : Infinity;
        const etaStr = isFinite(etaSecs) ? `${Math.round(etaSecs / 60)}m` : '?';
        const blockDate = new Date(block.time * 1000).toISOString().slice(0, 10);
        console.log(
          `block ${block.height}/${tipBlock} | date ${blockDate} | ` +
          `tx/s ${txPerSec} | tx/block ${txPerBlock} | ` +
          `remaining ${blocksRemaining} blocks | eta ${etaStr}`
        );
        lastReportTime = now;
        lastReportTx = totalTxProcessed;
        lastReportBlock = block.height;
      }

      if (block.height % 1000 === 0) {
        await setLastSyncedBlock(block.height);
      }
    }

    await setLastSyncedBlock(batch[batch.length - 1]);
    current += batch.length;
  }

  console.log('Historical sync complete');
}
