-- NOTE: the migration runner splits on semicolons, so none may appear in comments.
-- Proposal 009 covers hash pushes of 1-19 and 21-75 bytes. The empty push of
-- 76a90088ac is proposal 003's (Mt. Gox). The 009 detector accepted length 0
-- too, so the 23 Mt. Gox outputs carried {003,009} and per-rule views showed
-- their 2,609 BTC twice. The classifier now skips length 0, and this drops the stale tag.
-- Uses the GIN index on loss_rules. Bucket and totals are unchanged (003 is
-- provable on its own).
UPDATE utxos SET loss_rules = array_remove(loss_rules, '009')
WHERE loss_rules @> '{003,009}' AND script_hex = '76a90088ac';
