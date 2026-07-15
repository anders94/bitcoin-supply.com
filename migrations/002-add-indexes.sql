-- Homepage and losses page: allows ORDER BY block_number DESC without a sort step.
-- Partial (loss_bucket > 0) keeps index size small.
CREATE INDEX IF NOT EXISTS idx_utxos_loss_bucket_block
  ON utxos (loss_bucket, block_number DESC) WHERE loss_bucket > 0;

-- Transaction detail page: WHERE tx_hash = $1 can't use the primary key
-- (tx_hash, output_index, block_number) without block_number, so it scans all partitions.
CREATE INDEX IF NOT EXISTS idx_utxos_tx_hash
  ON utxos (tx_hash);

-- Quantum curve: window function SUM(value_sats) OVER (ORDER BY value_sats DESC)
-- WHERE pubkey_exposed = TRUE. Index lets PG read rows in sorted order without a sort step.
CREATE INDEX IF NOT EXISTS idx_utxos_pubkey_exposed_value
  ON utxos (value_sats DESC) WHERE pubkey_exposed = TRUE;

-- Dormancy snapshots (npm run snapshot): WHERE loss_bucket = 0 AND block_timestamp <= $1.
-- Partial index covers only active UTXOs, keeping it small.
CREATE INDEX IF NOT EXISTS idx_utxos_dormancy
  ON utxos (block_timestamp) WHERE loss_bucket = 0;

-- Concentration API: supports fast ORDER BY on pre-aggregated address_info table.
CREATE INDEX IF NOT EXISTS idx_address_info_balance
  ON address_info (utxo_value_sats DESC);
