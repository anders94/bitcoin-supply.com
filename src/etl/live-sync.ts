import { getBlock, getBlockHash, getBlockCount } from '../services/bitcoin-rpc.js';
import { processBlock } from './block-processor.js';
import { publishSSE } from '../services/sse.js';
import { pool } from '../db/index.js';
import { config } from '../config.js';
import { getLastSyncedBlock, setLastSyncedBlock } from './historical-sync.js';

const POLL_INTERVAL_MS = 60_000;

async function loadKnownBurnAddresses(): Promise<Set<string>> {
  const { rows } = await pool.query('SELECT address FROM known_burn_addresses');
  return new Set(rows.map((r: any) => r.address));
}

export async function runLiveSync(): Promise<void> {
  const knownBurnAddresses = await loadKnownBurnAddresses();

  while (true) {
    try {
      const chainTip = await getBlockCount();
      const confirmedTip = chainTip - config.etl.confirmationLag;
      const lastSynced = await getLastSyncedBlock();

      if (lastSynced === -1) {
        console.warn('No historical sync checkpoint found. Starting from genesis. Consider running historical sync first.');
      }

      const pending = confirmedTip - lastSynced;
      const now = new Date().toISOString();
      if (pending > 0) {
        console.log(`${now} poll: tip=${chainTip} confirmed=${confirmedTip} synced=${lastSynced} (${pending} to process)`);
      } else {
        console.log(`${now} poll: tip=${chainTip} confirmed=${confirmedTip} synced=${lastSynced} (up to date, lag=${config.etl.confirmationLag})`);
      }

      for (let height = lastSynced + 1; height <= confirmedTip; height++) {
        const hash = await getBlockHash(height);
        const block = await getBlock(hash);
        await processBlock(block, knownBurnAddresses);
        await setLastSyncedBlock(height);

        broadcastSSE({
          type: 'block',
          block_number: block.height,
          block_hash: hash,
          tx_count: block.tx.length,
        });

        console.log(`Live block ${block.height}: ${hash}`);
      }
    } catch (err) {
      console.error('Live sync error:', err);
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
