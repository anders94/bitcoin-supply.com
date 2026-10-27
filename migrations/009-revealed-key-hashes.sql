-- Proposal 022 at receipt time: which known key, if any, controls an address
-- that has never spent. One row per sibling hash of a public key that cannot
-- be reached from the address side alone (see reverseIndexEntries in
-- src/classifiers/exposure.ts):
--   h8     first 8 bytes (signed) of a HASH160: a P2PKH / P2WPKH key hash, or
--          a P2SH-P2WPKH script hash
--   key    the key encoding it came from. A lookup re-hashes it to confirm
--          the full 20 bytes, so prefix collisions cannot produce a match
--   block  the block the key became public
-- Duplicates (one key revealed at several addresses) are harmless. Filled by
-- the ETL as keys appear and, for history, by
-- `backfill-quantum-exposure.ts --phase keyindex`.
CREATE TABLE IF NOT EXISTS revealed_key_hashes (
  h8    BIGINT  NOT NULL,
  key   BYTEA   NOT NULL,
  block INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revealed_key_hashes_h8 ON revealed_key_hashes (h8);
