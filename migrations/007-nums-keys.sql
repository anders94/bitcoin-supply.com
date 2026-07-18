-- Proposal 018: curated NUMS (nothing-up-my-sleeve) x-coordinates. Outputs
-- paying to any spendable wrapping of these keys (P2TR output key, P2PK,
-- P2PKH/P2WPKH of the compressed key) are provably keyless burns. The ETL
-- derives every wrapping at startup, so new NUMS constants can be added here
-- without code changes -- same model as known_burn_addresses.
CREATE TABLE IF NOT EXISTS nums_keys (
  x_coord TEXT PRIMARY KEY,  -- 64 lowercase hex chars, x-only coordinate
  label   TEXT NOT NULL,
  notes   TEXT
);

INSERT INTO nums_keys (x_coord, label, notes) VALUES
  ('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0',
   'BIP-341 taproot NUMS point H',
   'lift_x(SHA256(ser(G))). The standard provably-keyless taproot internal key, matched here when used directly as an output key or P2PK/P2PKH/P2WPKH key. NOTE: the migration runner splits on semicolons, so none may appear in these strings.')
ON CONFLICT (x_coord) DO NOTHING;
