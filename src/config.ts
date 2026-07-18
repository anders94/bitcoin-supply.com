// Express accepts a boolean, hop count, or subnet list for 'trust proxy';
// env vars only carry strings, so coerce back to the intended type.
function parseTrustProxy(v: string | undefined): boolean | number | string {
  if (!v) return 'loopback';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return parseInt(v);
  return v;
}

export const config = {
  rpc: {
    host: process.env.RPCHOST || 'localhost',
    port: parseInt(process.env.RPCPORT || '8332'),
    username: process.env.RPCUSERNAME || 'bitcoin',
    password: process.env.RPCPASSWORD || '',
    network: process.env.RPCNETWORK || 'mainnet',
  },
  zmq: {
    address: process.env.ZMQADDRESS || 'tcp://localhost:28332',
  },
  db: {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432'),
    database: process.env.PGDATABASE || 'bitcoin_supply',
    user: process.env.PGUSER || 'bitcoin_supply',
    password: process.env.PGPASSWORD || 'changeme',
    max: 20,
  },
  // Local on-disk cache (node:sqlite) for immutable data — block metadata/loss
  // rows and confirmed raw transactions — so the web server stops round-tripping
  // to the remote Postgres/bitcoind for things that never change. Read-through
  // with fallback: any miss or error goes to the remote source, so the cache
  // can only make things faster, never wrong.
  cache: {
    enabled: process.env.CACHE_ENABLED !== 'false',
    dir: process.env.CACHE_DIR || './cache',
    // Don't cache anything within this many blocks of the tip — a reorg could
    // still rewrite it. Matches the ETL's confirmation lag: below tip-N the DB
    // itself treats a block as final.
    reorgDepth: parseInt(process.env.CACHE_REORG_DEPTH || '6'),
    // Soft cap on cached transactions (~2.4 KB each). 8M ≈ 19 GB, under a 20 GB
    // budget. Oldest are pruned past this.
    maxTxRows: parseInt(process.env.CACHE_MAX_TX || '8000000'),
  },
  redis: {
    host: process.env.REDISHOST || '127.0.0.1',
    port: parseInt(process.env.REDISPORT || '6379'),
    // Required once Redis listens past loopback: binding to another interface
    // takes it out from behind protected-mode, so it must have a password.
    // Undefined means no AUTH, which is correct for a loopback-only instance.
    password: process.env.REDISPASSWORD || undefined,
  },
  server: {
    host: process.env.HOST || '0.0.0.0',
    port: parseInt(process.env.PORT || '3000'),
    // Canonical origin for absolute URLs (Open Graph, canonical links).
    publicUrl: (process.env.PUBLIC_URL || 'https://bitcoin-supply.com').replace(/\/+$/, ''),
    // Which hops may set X-Forwarded-For. Defaults to 'loopback' for nginx on
    // the same host; set TRUST_PROXY to the proxy's IP/subnet if it isn't.
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  },
  etl: {
    concurrency: parseInt(process.env.ETL_CONCURRENCY || '8'),
    batchSize: parseInt(process.env.ETL_BATCH_SIZE || '1000'),
    confirmationLag: parseInt(process.env.ETL_CONFIRMATION_LAG || '6'),
  },
  // Max possible supply in satoshis (2099999997690000)
  maxSupplySats: 2099999997690000n,
};
