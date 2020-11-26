-----------------------
-- table: logs
-----------------------
CREATE TABLE IF NOT EXISTS logs (
  created                TIMESTAMP  NOT NULL DEFAULT now(),
  entity                 TEXT       NOT NULL, -- backend, util, etc.
  summary                TEXT       NOT NULL, -- processed block, inserted transaction
  detail                 TEXT       NOT NULL  -- 123456, xxxxxxx...xxxxxx
);
