CREATE TABLE IF NOT EXISTS blocks (
  block_number BIGINT PRIMARY KEY,
  block_hash TEXT NOT NULL UNIQUE,
  block_timestamp TIMESTAMPTZ NOT NULL,
  tx_count INTEGER NOT NULL,
  coinbase_value_sats BIGINT NOT NULL,
  allowed_supply_sats BIGINT NOT NULL,
  miner_loss_sats BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON blocks (block_timestamp);

CREATE TABLE IF NOT EXISTS utxos (
  tx_hash TEXT NOT NULL,
  output_index INTEGER NOT NULL,
  value_sats BIGINT NOT NULL,
  block_number BIGINT NOT NULL,
  block_timestamp TIMESTAMPTZ NOT NULL,
  script_hex TEXT NOT NULL,
  script_type TEXT,
  address TEXT,
  loss_rules TEXT[] NOT NULL DEFAULT '{}',
  loss_bucket SMALLINT NOT NULL DEFAULT 0,
  pubkey_exposed BOOLEAN NOT NULL DEFAULT FALSE,
  pubkey_hex TEXT,
  PRIMARY KEY (tx_hash, output_index, block_number)
) PARTITION BY RANGE (block_number);

CREATE TABLE IF NOT EXISTS utxos_epoch_0 PARTITION OF utxos FOR VALUES FROM (0) TO (210000);
CREATE TABLE IF NOT EXISTS utxos_epoch_1 PARTITION OF utxos FOR VALUES FROM (210000) TO (420000);
CREATE TABLE IF NOT EXISTS utxos_epoch_2 PARTITION OF utxos FOR VALUES FROM (420000) TO (630000);
CREATE TABLE IF NOT EXISTS utxos_epoch_3 PARTITION OF utxos FOR VALUES FROM (630000) TO (840000);
CREATE TABLE IF NOT EXISTS utxos_epoch_4 PARTITION OF utxos FOR VALUES FROM (840000) TO (1050000);

CREATE INDEX IF NOT EXISTS idx_utxos_block_timestamp ON utxos (block_timestamp);
CREATE INDEX IF NOT EXISTS idx_utxos_loss_bucket ON utxos (loss_bucket) WHERE loss_bucket > 0;
CREATE INDEX IF NOT EXISTS idx_utxos_loss_rules_gin ON utxos USING GIN (loss_rules);
CREATE INDEX IF NOT EXISTS idx_utxos_address ON utxos (address) WHERE address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_utxos_pubkey_exposed ON utxos (pubkey_exposed) WHERE pubkey_exposed = TRUE;
CREATE INDEX IF NOT EXISTS idx_utxos_value_desc ON utxos (value_sats DESC);

CREATE TABLE IF NOT EXISTS address_info (
  address TEXT PRIMARY KEY,
  first_seen_block BIGINT NOT NULL,
  last_active_block BIGINT NOT NULL,
  pubkey_hex TEXT,
  pubkey_exposed_at_block BIGINT,
  utxo_count INTEGER NOT NULL DEFAULT 0,
  utxo_value_sats BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_address_pubkey ON address_info (pubkey_exposed_at_block) WHERE pubkey_exposed_at_block IS NOT NULL;

CREATE TABLE IF NOT EXISTS loss_snapshots (
  snapshot_key TEXT PRIMARY KEY,
  total_sats BIGINT NOT NULL,
  utxo_count BIGINT NOT NULL,
  computed_at_block BIGINT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS known_burn_addresses (
  address TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  proposal_id TEXT NOT NULL DEFAULT '012',
  notes TEXT
);

CREATE TABLE IF NOT EXISTS etl_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
