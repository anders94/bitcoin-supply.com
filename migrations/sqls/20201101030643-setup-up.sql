-----------------
-- table: blocks
-----------------
CREATE TABLE IF NOT EXISTS blocks (
  block_number         INT        NOT NULL UNIQUE,
  block_timestamp      TIMESTAMP,
  input_sum            BIGINT,
  output_sum           BIGINT,
  fees                 BIGINT,
  op_return_loss       BIGINT,
  allowed_supply       BIGINT     NOT NULL,
  new_supply           BIGINT,
  current_total_supply BIGINT,
  blocks_till_halving  INT        NOT NULL,
  anomoly              BOOLEAN    NOT NULL DEFAULT FALSE,
  description          TEXT,
  attributes           JSONB      NOT NULL DEFAULT '{}'::JSONB
);

-----------------
-- table: oneoffs
-----------------
CREATE TABLE IF NOT EXISTS oneoffs (
  block_number         INT        NOT NULL UNIQUE,
  new_supply           BIGINT     NOT NULL,
  description          TEXT       NOT NULL,
  attributes           JSONB      NOT NULL DEFAULT '{}'::JSONB
);
