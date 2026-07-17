import 'dotenv/config';
import { runHistoricalSync } from './historical-sync.js';
import { runLiveSync } from './live-sync.js';
import { updateSnapshots } from './snapshot-updater.js';

const mode = process.argv[2] || 'historical';

// The ETL needs no Redis. It used to connect solely to publish block events for
// the web server's SSE stream; the web server now polls the tip for itself, so
// this process talks only to Postgres and bitcoind. That also means Redis can
// stay bound to loopback on the web box, with no password and nothing exposed.
async function main() {
  if (mode === 'historical') {
    await runHistoricalSync();
    await updateSnapshots();
  } else if (mode === 'live') {
    // Run snapshot updater hourly
    setInterval(updateSnapshots, 60 * 60 * 1000);
    console.log('Computing initial snapshots...');
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
