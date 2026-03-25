import { getBlockHash, getBlock, getBlockCount } from '../services/bitcoin-rpc.js';
import { processBlock } from './block-processor.js';
import { pool } from '../db/index.js';
import { config } from '../config.js';

async function loadKnownBurnAddresses(): Promise<Set<string>> {
  const { rows } = await pool.query('SELECT address FROM known_burn_addresses');
  return new Set(rows.map((r: any) => r.address));
}

async function getLastSyncedBlock(): Promise<number> {
  const { rows } = await pool.query("SELECT value FROM etl_state WHERE key = 'last_synced_block'");
  return parseInt(rows[0]?.value ?? '-1');
}

async function setLastSyncedBlock(n: number): Promise<void> {
  await pool.query(
    "UPDATE etl_state SET value = $1, updated_at = now() WHERE key = 'last_synced_block'",
    [n.toString()]
  );
}

export async function runHistoricalSync(startBlock?: number): Promise<void> {
  const knownBurnAddresses = await loadKnownBurnAddresses();
  const lastSynced = startBlock ?? await getLastSyncedBlock();
  const tipBlock = await getBlockCount();

  console.log(`Historical sync: blocks ${lastSynced + 1} to ${tipBlock}`);

  const concurrency = config.etl.concurrency;
  let current = lastSynced + 1;

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
      await processBlock(block, knownBurnAddresses);
      if (block.height % 1000 === 0) {
        console.log(`Processed block ${block.height} / ${tipBlock}`);
        await setLastSyncedBlock(block.height);
      }
    }

    await setLastSyncedBlock(batch[batch.length - 1]);
    current += batch.length;
  }

  console.log('Historical sync complete');
}
