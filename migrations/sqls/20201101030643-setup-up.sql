-----------------
-- table: blocks
-----------------
CREATE TABLE IF NOT EXISTS blocks (
  created              TIMESTAMP  NOT NULL DEFAULT now(),
  block_number         INT        NOT NULL UNIQUE,
  block_timestamp      TIMESTAMP  NOT NULL,
  input_sum            BIGINT,
  output_sum           BIGINT,
  fees                 BIGINT,
  transactional_loss   BIGINT,
  allowed_supply       BIGINT     NOT NULL,
  new_supply           BIGINT,
  current_total_supply BIGINT,
  blocks_till_halving  INT        NOT NULL,
  loss                 BOOLEAN    NOT NULL DEFAULT FALSE,
  description          TEXT,
  attributes           JSONB      NOT NULL DEFAULT '{}'::JSONB
);

-----------------
-- table: oneoffs
-----------------
CREATE TABLE IF NOT EXISTS oneoffs (
  created              TIMESTAMP  NOT NULL DEFAULT now(),
  block_number         INT        NOT NULL UNIQUE,
  new_supply           BIGINT     NOT NULL,
  description          TEXT       NOT NULL,
  attributes           JSONB      NOT NULL DEFAULT '{}'::JSONB
);
