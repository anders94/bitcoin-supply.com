-----------------
-- table: blocks
-----------------
CREATE TABLE IF NOT EXISTS blocks (
  created              TIMESTAMP  NOT NULL DEFAULT now(),
  block_hash           TEXT,
  block_size           BIGINT,
  stripped_size        BIGINT,
  weight               BIGINT,
  block_number         BIGINT     NOT NULL UNIQUE,
  version              BIGINT,
  merkle_root          TEXT,
  block_timestamp      TIMESTAMP  NOT NULL,
  nonce                TEXT,
  bits                 TEXT,
  coinbase_param       TEXT,
  transaction_count    BIGINT,
  input_sum            BIGINT,
  output_sum           BIGINT,
  fee_sum              BIGINT,
  transactional_loss   BIGINT,
  allowed_supply       BIGINT     NOT NULL,
  new_supply           BIGINT,
  current_total_supply BIGINT,
  blocks_till_halving  BIGINT     NOT NULL,
  supply_loss          BOOLEAN    NOT NULL DEFAULT FALSE,
  attributes           JSONB      NOT NULL DEFAULT '{}'::JSONB
);

-------------------
-- table: anomolies
-------------------
CREATE TABLE IF NOT EXISTS anomolies (
  created              TIMESTAMP  NOT NULL DEFAULT now(),
  block_number         BIGINT     NOT NULL UNIQUE,
  new_supply           BIGINT     NOT NULL,
  description          TEXT       NOT NULL,
  attributes           JSONB      NOT NULL DEFAULT '{}'::JSONB
);
