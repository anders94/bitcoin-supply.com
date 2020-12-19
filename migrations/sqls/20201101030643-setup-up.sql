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
  allowed_supply       BIGINT     NOT NULL,
  new_supply           BIGINT,
  transactional_loss   BIGINT,
  current_total_supply BIGINT,
  blocks_till_halving  BIGINT     NOT NULL,
  supply_loss          BOOLEAN    NOT NULL DEFAULT FALSE,
  attributes           JSONB      NOT NULL DEFAULT '{}'::JSONB
);

-----------------------
-- table: transactions
-----------------------
CREATE TABLE IF NOT EXISTS transactions (
  created                TIMESTAMP  NOT NULL DEFAULT now(),
  block_number           BIGINT     NOT NULL REFERENCES blocks(block_number),
  tx_hash                TEXT       NOT NULL UNIQUE,
  tx_size                BIGINT,
  virtual_size           BIGINT,
  version                BIGINT,
  lock_time              BIGINT,
  is_coinbase            BOOLEAN,
  input_value            BIGINT,
  output_value           BIGINT,
  fee                    BIGINT,
  attributes             JSONB      NOT NULL DEFAULT '{}'::JSONB
);

-----------------------
-- table: inputs
-----------------------
CREATE TABLE IF NOT EXISTS inputs (
  created                TIMESTAMP  NOT NULL DEFAULT now(),
  tx_hash                TEXT       NOT NULL REFERENCES transactions(tx_hash),
  input_index            BIGINT,
  spent_transaction_hash TEXT,
  spent_output_index     BIGINT,
  script_asm             TEXT,
  script_hex             TEXT,
  input_sequence         BIGINT,
  required_signatures    BIGINT,
  input_type             TEXT,
  addresses              TEXT[],
  input_value            BIGINT,
  attributes             JSONB      NOT NULL DEFAULT '{}'::JSONB,
  UNIQUE (tx_hash, input_index)
);

-----------------------
-- table: outputs
-----------------------
CREATE TABLE IF NOT EXISTS outputs (
  created                TIMESTAMP  NOT NULL DEFAULT now(),
  tx_hash                TEXT       NOT NULL REFERENCES transactions(tx_hash),
  output_index           BIGINT,
  script_asm             TEXT,
  script_hex             TEXT,
  required_signatures    BIGINT,
  output_type            TEXT,
  addresses              TEXT[],
  output_value	         BIGINT,
  supply_loss            BOOLEAN    NOT NULL DEFAULT FALSE,
  attributes             JSONB      NOT NULL DEFAULT '{}'::JSONB,
  UNIQUE (tx_hash, output_index)
);
