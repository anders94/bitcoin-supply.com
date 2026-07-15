-- Add pubkey_exposed and is_p2pk flags to address_info for fast quantum page queries.
-- Without these, the quantum page must GROUP BY all pubkey_exposed UTXOs (full table scan).

ALTER TABLE address_info
  ADD COLUMN IF NOT EXISTS pubkey_exposed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_p2pk BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: exposed P2PKH addresses already have pubkey_exposed_at_block set
UPDATE address_info SET pubkey_exposed = TRUE
WHERE pubkey_exposed_at_block IS NOT NULL;

-- Backfill: P2PK addresses (loss rule 015) with a known address
UPDATE address_info ai SET pubkey_exposed = TRUE, is_p2pk = TRUE
FROM (
  SELECT DISTINCT address FROM utxos
  WHERE pubkey_exposed = TRUE AND loss_rules @> '{015}' AND address IS NOT NULL
) p2pk
WHERE ai.address = p2pk.address;

-- Partial index to serve the quantum page top-100 query via index scan
CREATE INDEX IF NOT EXISTS idx_address_info_pubkey_exposed
  ON address_info (utxo_value_sats DESC) WHERE pubkey_exposed = TRUE;
