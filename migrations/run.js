require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Ordered list of migrations to apply.
// NEVER remove or reorder entries — only append new ones.
const MIGRATIONS = [
  '001-initial-schema.sql',
  '001-seed-data.sql',
  '002-add-indexes.sql',
  '003-address-info-exposure.sql',
  '004-redesign-stats.sql',
  '005-losses-order-index.sql',
  '006-address-value-index.sql',
  '007-nums-keys.sql',
];

async function run() {
  const client = new Client({
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432'),
    database: process.env.PGDATABASE || 'bitcoin_supply',
    user: process.env.PGUSER || 'bitcoin_supply',
    password: process.env.PGPASSWORD || 'changeme',
  });
  await client.connect();

  // Create migration tracking table
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // If schema_migrations is empty but the database already has migration 003 applied
  // (detected by the pubkey_exposed column), pre-seed all existing migrations so
  // they are never re-executed. This handles the transition from the old runner.
  const { rows: existing } = await client.query('SELECT count(*) n FROM schema_migrations');
  if (parseInt(existing[0].n) === 0) {
    const { rows: col } = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'address_info' AND column_name = 'pubkey_exposed'
    `);
    if (col.length > 0) {
      console.log('Existing database detected — pre-seeding migration history...');
      for (const name of MIGRATIONS) {
        await client.query(
          'INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
          [name]
        );
      }
      console.log('All existing migrations marked as applied. Nothing to run.');
      await client.end();
      return;
    }
  }

  // Apply any migrations not yet recorded in schema_migrations
  let applied = 0;
  for (const name of MIGRATIONS) {
    const { rows } = await client.query(
      'SELECT 1 FROM schema_migrations WHERE name = $1',
      [name]
    );
    if (rows.length > 0) {
      console.log(`  skip  ${name} (already applied)`);
      continue;
    }

    console.log(`  apply ${name}`);
    const sql = fs.readFileSync(path.join(__dirname, name), 'utf8');
    // Split on semicolons so each statement runs separately (required for some DDL)
    const stmts = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of stmts) {
      const label = stmt.split('\n').find(l => l.match(/^(CREATE|ALTER|UPDATE|INSERT|DROP)/)) || stmt.slice(0, 60);
      console.log(`    ${label}`);
      await client.query(stmt);
    }

    await client.query(
      'INSERT INTO schema_migrations (name, applied_at) VALUES ($1, now())',
      [name]
    );
    applied++;
    console.log(`  done  ${name}`);
  }

  if (applied === 0) {
    console.log('Nothing to migrate — database is up to date.');
  } else {
    console.log(`Migration complete. ${applied} migration(s) applied.`);
  }

  await client.end();
}

run().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
