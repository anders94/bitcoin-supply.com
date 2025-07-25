const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool(config.postgres);
let client;
let connected = false;

module.exports = {
    connect: async () => {
	if (!client)
	    client = await pool.connect();
	if (client)
	    connected = true;
    },

    isConnected: () => connected,

    begin: () => client.query('BEGIN'),

    query: (sql, params) => client.query(sql, params),

    commit: () => client.query('COMMIT'),

    rollback: () => client.query('ROLLBACK'),

    end: () => client.end(),

    getLatestBlock: async () => {
	const res = await client.query(
            `SELECT block_number
             FROM blocks
             ORDER BY block_number DESC
             LIMIT 1`);

	if (res.rows[0])
            return Number(res.rows[0].block_number);
	else
            return -1;
    },

    getBlock: async (block_number) => {
	const res = await client.query(
            `SELECT *
             FROM blocks
             WHERE block_number = $1`, [block_number]);

        return res.rows[0];
    },

    upsertBlock: async (block) => {
	// regularize
	block.hash = block.block_hash ? block.block_hash : block.hash;
	block.size = block.block_size ? block.block_size : block.size;
	block.number = block.block_number ? block.block_number : block.number;
	block.timestamp = block.block_timestamp ? block.block_timestamp.getTime() / 1000 : block.timestamp;

	console.log('upsert block', block.number, new Date(block.timestamp * 1000));

	await client.query(
            `INSERT INTO blocks
               (block_hash, block_size, stripped_size, weight, block_number,
                version, merkle_root, block_timestamp, nonce, bits, coinbase_param,
                transaction_count, input_sum, output_sum, fee_sum, transactional_loss,
                allowed_supply, new_supply, current_total_supply, blocks_till_halving,
                supply_loss, attributes)
             VALUES
               ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                $15, $16, $17, $18, $19, $20, $21, $22)
             ON CONFLICT (block_number) DO
               UPDATE SET
                 block_hash = $1, block_size = $2, stripped_size = $3, weight = $4, block_number = $5,
                 version = $6, merkle_root = $7, block_timestamp = $8, nonce = $9, bits = $10, coinbase_param = $11,
                 transaction_count = $12, input_sum = $13, output_sum = $14, fee_sum = $15, transactional_loss = $16,
                 allowed_supply = $17, new_supply = $18, current_total_supply = $19, blocks_till_halving = $20,
                 supply_loss = $21, attributes = $22`,
	    [block.hash, block.size, block.stripped_size, block.weight, block.number,
	     block.version, block.merkle_root, new Date(block.timestamp * 1000), block.nonce, block.bits, block.coinbase_param,
	     block.transaction_count, block.input_sum, block.output_sum, block.fee_sum, block.transactional_loss,
	     block.allowed_supply, block.new_supply, block.current_total_supply, 210000n - (BigInt(block.number) % 210000n),
	     block.supply_loss ? true : false, block.attributes ? block.attributes : {}]);
    },

    getInputs: async (tx_hash) => {
	const res = await client.query(
            `SELECT *
             FROM inputs
             WHERE tx_hash = $1`, [tx_hash]);

        return res.rows;
    },

    upsertInputs: async (txhash, inputs) => {
	console.log('    upsertInputs(', txhash, ',', inputs.length, ')');
	for (let i=0; i<inputs.length; i++) {
            let input = inputs[i];

	    // regularize
	    input.index = input.input_index ? input.input_index : input.index;
	    input.sequence = input.input_sequence ? input.input_sequence : input.sequence;
	    input.type = input.input_type ? input.input_type : input.type;
	    input.value = input.input_value ? input.input_value : input.value;

	    console.log('      add input', txhash, input.index, input.value);
            await client.query(
		`DELETE
                 FROM inputs
                 WHERE tx_hash = $1
                   AND input_index = $2`,
		[txhash, input.index]);

            await client.query(
		`INSERT INTO inputs
                   (tx_hash, input_index, spent_transaction_hash, spent_output_index,
                    script_asm, script_hex, input_sequence, required_signatures,
                    input_type, addresses, input_value)
                 VALUES
                   ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		[txhash, input.index, input.spent_transaction_hash, input.spent_output_index,
		 input.script_asm, input.script_hex, input.sequence, input.required_signatures,
		 input.type, input.addresses, input.value]);

	}
    },

    getOutputs: async (tx_hash) => {
	const res = await client.query(
            `SELECT *
             FROM outputs
             WHERE tx_hash = $1`, [tx_hash]);

        return res.rows;
    },

    upsertOutputs: async (txhash, outputs) => {
	console.log('    upsertOutputs(', txhash, ',', outputs.length, ')');
	for (let o=0; o<outputs.length; o++) {
            let output = outputs[o];

	    // regularize
	    output.index = output.output_index ? output.output_index : output.index;
	    output.type = output.output_type ? output.output_type : output.type;
	    output.value = output.output_value ? output.output_value : output.value;

	    console.log('      add output', txhash, output.index, output.value);
            await client.query(
		`DELETE
                 FROM outputs
                 WHERE tx_hash = $1
                   AND output_index = $2`,
		[txhash, output.index]);

            await client.query(
		`INSERT INTO outputs
                   (tx_hash, supply_loss, output_index, script_asm, script_hex,
                    required_signatures, output_type, addresses, output_value,
                    attributes)
                 VALUES
                   ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		[txhash, output.supply_loss ? true : false, output.index,
		 output.script_asm, output.script_hex,
		 output.required_signatures, output.type,
		 output.addresses, output.value,
		 output.attributes ? output.attributes : {}]);
	}
    },

    getTransaction: async (tx_hash) => {
	const res = await client.query(
            `SELECT *
             FROM transactions
             WHERE tx_hash = $1`, [tx_hash]);

        return res.rows[0];
    },

    upsertTransaction: async (tx) => {
	// regularize
	tx.hash = tx.tx_hash ? tx.tx_hash : tx.hash;
	tx.size = tx.tx_size ? tx.tx_size : tx.size;

	console.log('  upsertTransaction(', tx.hash, ')');
	await client.query(
            `INSERT INTO transactions
               (block_number, tx_hash, tx_size, virtual_size,
                version, lock_time, is_coinbase, input_value,
                output_value, fee)
             VALUES
               ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (tx_hash) DO
               UPDATE SET
                 block_number = $1, tx_size = $3, virtual_size = $4,
                 version = $5, lock_time = $6, is_coinbase = $7, input_value = $8,
                 output_value = $9, fee = $10`,
            [tx.block_number, tx.hash, tx.size, tx.virtual_size,
             tx.version, tx.lock_time, tx.is_coinbase ? true : false,
             tx.input_value, tx.output_value, tx.fee]);
    }

}
