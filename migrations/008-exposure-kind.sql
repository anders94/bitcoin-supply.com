-- How an address's key(s) became visible on-chain. NULL on rows written before
-- this migration: readers fall back to is_p2pk ? 'p2pk' : 'pkh' (the only two
-- kinds the ETL could produce until now). The backfill script fills it in.
--   p2pk          key in a P2PK output script (Proposal 015)
--   p2tr          taproot output key (Proposal 019)
--   p2ms          bare multisig keys (Proposal 020)
--   pkh           key revealed by a P2PKH / P2WPKH / P2SH-P2WPKH spend (016)
--   script        keys revealed by a P2SH / P2WSH script spend, key-only script (021)
--   script-mixed  same, but the script also has hash-preimage conditions (021)
ALTER TABLE address_info
  ADD COLUMN IF NOT EXISTS exposure_kind TEXT;

CREATE INDEX IF NOT EXISTS idx_address_info_exposure_kind
  ON address_info (exposure_kind) WHERE exposure_kind IS NOT NULL;
