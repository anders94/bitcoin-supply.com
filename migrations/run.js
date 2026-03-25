const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function run() {
  const client = new Client({
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432'),
    database: process.env.PGDATABASE || 'bitcoin_supply',
    user: process.env.PGUSER || 'bitcoin_supply',
    password: process.env.PGPASSWORD || 'changeme',
  });
  await client.connect();
  const schema = fs.readFileSync(path.join(__dirname, '001-initial-schema.sql'), 'utf8');
  const seed = fs.readFileSync(path.join(__dirname, '001-seed-data.sql'), 'utf8');
  await client.query(schema);
  await client.query(seed);
  console.log('Migration complete');
  await client.end();
}
run().catch(console.error);
