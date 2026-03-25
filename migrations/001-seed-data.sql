INSERT INTO known_burn_addresses (address, label, proposal_id, notes) VALUES
('1BitcoinEaterAddressDontSendf59kuE', 'Bitcoin Eater', '012', 'Vanity address with no known private key'),
('1111111111111111111114oLvT2', 'All-zeros hash160', '012', 'P2PKH of all-zero hash160'),
('1HELLowoRLD62pG6oLZXRbhW3uHnFpEBqV', 'Hello World', '012', 'Vanity burn address'),
('1BitcoinEaterAddressDontSendkbykwk', 'Bitcoin Eater 2', '012', NULL)
ON CONFLICT DO NOTHING;

INSERT INTO etl_state (key, value) VALUES
('last_synced_block', '-1'),
('sync_mode', 'historical')
ON CONFLICT DO NOTHING;
