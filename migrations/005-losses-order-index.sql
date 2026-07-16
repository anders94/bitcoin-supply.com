-- /losses lists loss UTXOs newest-first with LIMIT/OFFSET. The ORDER BY
-- (block_number DESC, value_sats DESC) must match an index order exactly,
-- otherwise Postgres sorts all ~238M loss rows on every page view.
-- This partial index gives a MergeAppend across partitions with LIMIT
-- pushdown. It also serves the block loss-pager MAX/MIN lookups and the
-- homepage recent-losses query.
CREATE INDEX IF NOT EXISTS idx_utxos_loss_by_block
  ON utxos (block_number DESC, value_sats DESC) WHERE loss_bucket IN (1, 2);
