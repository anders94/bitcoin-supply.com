DELETE FROM inputs i LEFT JOIN transactions t ON i.tx_hash = t.tx_hash WHERE t.block_number >= 200001 AND t.block_number <= 300000;
DELETE FROM outputs o LEFT JOIN transactions t ON o.tx_hash = t.tx_hash WHERE t.block_number >= 200001 AND t.block_number <= 300000;
DELETE FROM transactions WHERE block_number >= 200001 AND block_number <= 300000;
DELETE FROM blocks WHERE block_number >= 200001 AND block_number <= 300000;
