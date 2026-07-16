-- /address/:addr lists an address's UTXOs by value. With only the plain
-- address index, the planner may instead walk the global value-ordered index
-- filtering by address -- for dust-heavy burn addresses that approaches a
-- full-index scan (minutes). A composite (address, value_sats DESC) index
-- serves both the filter and the sort, and subsumes the plain address index.
CREATE INDEX IF NOT EXISTS idx_utxos_address_value
  ON utxos (address, value_sats DESC) WHERE address IS NOT NULL;

DROP INDEX IF EXISTS idx_utxos_address;
