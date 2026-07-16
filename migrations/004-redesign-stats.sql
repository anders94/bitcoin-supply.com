-- Redesign support: precomputed stat blobs, daily snapshot history, and
-- indexes for the block loss-pager and top-losses queries.

-- JSON blobs computed hourly by the ETL snapshot job (rule breakdown,
-- quantum curve, age/value matrix, top losses, halvings, dormant giants).
CREATE TABLE IF NOT EXISTS computed_stats (
  key TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  computed_at_block BIGINT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Daily time series of supply snapshots. The hourly job upserts today's row;
-- the one-time backfill inserts historical Dec-31 rows (exact for provable
-- loss, since bucket-1 UTXOs are unspendable and never deleted).
CREATE TABLE IF NOT EXISTS snapshot_history (
  as_of_date DATE NOT NULL,
  snapshot_key TEXT NOT NULL,
  total_sats BIGINT NOT NULL,
  utxo_count BIGINT NOT NULL,
  computed_at_block BIGINT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (as_of_date, snapshot_key)
);

-- Block loss-pager: nearest block with a miner underclaim (rule 002).
CREATE INDEX IF NOT EXISTS idx_blocks_miner_loss
  ON blocks (block_number) WHERE miner_loss_sats > 0;

-- Top losses: largest loss UTXOs (buckets 1+2 only -- bucket 4 is not a loss).
CREATE INDEX IF NOT EXISTS idx_utxos_loss_value
  ON utxos (value_sats DESC) WHERE loss_bucket IN (1, 2);

-- Dormancy includes quantum-tagged P2PK outputs (bucket 4): they are dormant
-- Satoshi-era coin on the loss axis -- the quantum tag is an independent lens.
DROP INDEX IF EXISTS idx_utxos_dormancy;

CREATE INDEX IF NOT EXISTS idx_utxos_dormancy
  ON utxos (block_timestamp) WHERE loss_bucket IN (0, 4);
