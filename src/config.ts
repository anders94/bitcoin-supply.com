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
  redis: {
    host: process.env.REDISHOST || '127.0.0.1',
    port: parseInt(process.env.REDISPORT || '6379'),
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
