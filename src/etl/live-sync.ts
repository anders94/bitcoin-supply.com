import * as zmq from 'zeromq';
import { getBlock } from '../services/bitcoin-rpc.js';
import { processBlock } from './block-processor.js';
import { broadcastSSE } from '../services/sse.js';
import { pool } from '../db/index.js';
import { config } from '../config.js';

async function loadKnownBurnAddresses(): Promise<Set<string>> {
  const { rows } = await pool.query('SELECT address FROM known_burn_addresses');
  return new Set(rows.map((r: any) => r.address));
}

export async function runLiveSync(): Promise<void> {
  const knownBurnAddresses = await loadKnownBurnAddresses();

  while (true) {
    try {
      const sock = new zmq.Subscriber();
      sock.connect(config.zmq.address);
      sock.subscribe('sequence');

      console.log(`ZMQ live sync connected to ${config.zmq.address}`);

      for await (const [topic, message] of sock) {
        if (topic.toString() === 'sequence') {
          // Block connected: frame starts with 0x43 ('C')
          if (message[0] === 0x43) {
            // Next 32 bytes are the block hash in little-endian
            const hashBytes = message.slice(1, 33);
            const hash = Buffer.from(hashBytes).reverse().toString('hex');

            try {
              const block = await getBlock(hash);
              await processBlock(block, knownBurnAddresses);

              broadcastSSE({
                type: 'block',
                block_number: block.height,
                block_hash: hash,
                tx_count: block.tx.length,
              });

              console.log(`Live block ${block.height}: ${hash}`);
            } catch (err) {
              console.error(`Error processing block ${hash}:`, err);
            }
          }
        }
      }
    } catch (err) {
      console.error('ZMQ connection error, reconnecting in 5s:', err);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}
