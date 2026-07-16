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
    port: parseInt(process.env.PORT || '3000'),
  },
  etl: {
    concurrency: parseInt(process.env.ETL_CONCURRENCY || '8'),
    batchSize: parseInt(process.env.ETL_BATCH_SIZE || '1000'),
    confirmationLag: parseInt(process.env.ETL_CONFIRMATION_LAG || '6'),
  },
  // Max possible supply in satoshis (2099999997690000)
  maxSupplySats: 2099999997690000n,
};
