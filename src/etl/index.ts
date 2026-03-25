import { runHistoricalSync } from './historical-sync.js';
import { runLiveSync } from './live-sync.js';
import { updateSnapshots } from './snapshot-updater.js';
import { connectRedis } from '../services/redis.js';

const mode = process.argv[2] || 'historical';

async function main() {
  await connectRedis();

  if (mode === 'historical') {
    await runHistoricalSync();
    await updateSnapshots();
  } else if (mode === 'live') {
    // Run snapshot updater hourly
    setInterval(updateSnapshots, 60 * 60 * 1000);
    await updateSnapshots(); // Initial run
    await runLiveSync(); // Blocks forever
  } else if (mode === 'snapshot') {
    await updateSnapshots();
  } else {
    console.error('Unknown mode. Use: historical | live | snapshot');
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
