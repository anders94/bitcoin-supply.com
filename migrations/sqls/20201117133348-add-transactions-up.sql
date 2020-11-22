-----------------------
-- table: transactions
-----------------------
CREATE TABLE IF NOT EXISTS transactions (
  created                TIMESTAMP  NOT NULL DEFAULT now(),
  block_number           INT        NOT NULL REFERENCES blocks(block_number),
  tx_hash                TEXT       NOT NULL UNIQUE,
  tx_size                INT,
  virtual_size           INT,
  version                INT,
  lock_time              BIGINT,
  is_coinbase            BOOLEAN,
  input_value            BIGINT,
  output_value           BIGINT,
  fee                    BIGINT
);

-----------------------
-- table: inputs
-----------------------
CREATE TABLE IF NOT EXISTS inputs (
  created                TIMESTAMP  NOT NULL DEFAULT now(),
  tx_hash                TEXT       NOT NULL REFERENCES transactions(tx_hash),
  input_index            INT,
  spent_transaction_hash TEXT,
  spent_output_index     INT,
  script_asm             TEXT,
  script_hex             TEXT,
  input_sequence         BIGINT,
  required_signatures    INT,
  input_type             TEXT,
  addresses              TEXT[],
  input_value            BIGINT,
  description            TEXT,
  attributes             JSONB      NOT NULL DEFAULT '{}'::JSONB
);

-----------------------
-- table: outputs
-----------------------
CREATE TABLE IF NOT EXISTS outputs (
  created                TIMESTAMP  NOT NULL DEFAULT now(),
  tx_hash                TEXT       NOT NULL REFERENCES transactions(tx_hash),
  anomoly                BOOLEAN    NOT NULL DEFAULT FALSE,
  output_index           INT,
  script_asm             TEXT,
  script_hex             TEXT,
  required_signatures    INT,
  output_type            TEXT,
  addresses              TEXT[],
  output_value	         BIGINT,
  description            TEXT,
  attributes             JSONB      NOT NULL DEFAULT '{}'::JSONB
);
