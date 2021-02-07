DELETE FROM inputs USING inputs i LEFT JOIN transactions t ON i.tx_hash = t.tx_hash WHERE t.block_number >= 100001 AND t.block_number <= 200000;
DELETE FROM outputs USING outputs o LEFT JOIN transactions t ON o.tx_hash = t.tx_hash WHERE t.block_number >= 100001 AND t.block_number <= 200000;
DELETE FROM transactions WHERE block_number >= 100001 AND block_number <= 200000;
DELETE FROM blocks WHERE block_number >= 100001 AND block_number <= 200000;
