const BitcoinClient = require('bitcoin-core');
const config = require('./config');
const db = require('./db');

const rpc = new BitcoinClient(config.bitcoinRPC);

const getLatestInsertedBlockNumber = async () => {
    const res = await db.query(
	`SELECT block_number
         FROM blocks
         ORDER BY block_number DESC
         LIMIT 1`);

    if (res.rows[0])
        return res.rows[0].block_number;
    else
        return 0;

}

const getLastBlockNumberProcessed = async () => {
    const res = await db.query(
	`SELECT detail
         FROM logs
         WHERE entity = 'backend'
           AND summary = 'processed block'
         ORDER BY created DESC
         LIMIT 1`);
    
    if (res.rows[0])
        return res.rows[0].detail;
    else
        return 0;

}

const getOutput = async (txid, idx) => {
    const tx = await getTransaction(txid);

    let out;
    for (let o=0; o<tx.vout.length; o++)
	if (tx.vout[o].n == idx) {
	    out = tx.vout[o];
	    out.value_int = BigInt(Math.round(out.value * 100000000));
	    out.spent_transaction_hash = txid;
	    out.spent_output_index = idx;
	}

    return out;
}

const insertLog = async (summary, detail) => {
    const res = await db.query(
	`INSERT INTO logs
           (entity, summary, detail)
         VALUES
           ('backend', $1, $2)`,
	[summary, detail]);
    
    if (res.rows[0])
        return res.rows[0].detail;
    else
        return 0;

}

const upsertTransaction = async (tx) => {
    await db.query(
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
	[tx.block_number, tx.txid, tx.size, tx.vsize,
	 tx.version, tx.locktime, tx.vin[0].coinbase ? true : false,
	 tx.input_value, tx.output_value, tx.fee]);

};

const upsertInputs = async (txid, inputs) => {
    for (let i=0; i<inputs.length; i++) {
	const input = inputs[i];

	await db.query(
	    `DELETE
             FROM inputs
             WHERE tx_hash = $1
               AND input_index = $2`,
	    [txid, input.n]);

	await db.query(
            `INSERT INTO inputs
               (tx_hash, input_index, spent_transaction_hash, spent_output_index,
                script_asm, script_hex, input_sequence, required_signatures,
                input_type, addresses, input_value)
             VALUES
               ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
	    [txid, input.n, input.spent_transaction_hash, input.spent_output_index,
	     input.scriptPubKey.asm, input.scriptPubKey.hex, null, input.scriptPubKey.reqSigs,
	     input.scriptPubKey.type, input.scriptPubKey.addresses, input.value_int]);

    }
}

const upsertOutputs = async (txid, outputs) => {
    for (let o=0; o<outputs.length; o++) {
	const output = outputs[o];

	await db.query(
	    `DELETE
             FROM outputs
             WHERE tx_hash = $1
               AND output_index = $2`,
	    [txid, output.n]);

	await db.query(
            `INSERT INTO outputs
               (tx_hash, loss, output_index, script_asm, script_hex,
                required_signatures, output_type, addresses, output_value,
                description)
             VALUES
               ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
	    [txid, output.loss ? true : false, output.n,
	     output.scriptPubKey.asm, output.scriptPubKey.hex,
	     output.scriptPubKey.reqSigs, output.scriptPubKey.type,
	     output.scriptPubKey.addresses, output.value_int,
	     output.description]);

    }
}

const getBlock = async (height) => {
    const hash = await rpc.getBlockHash(Number(height));
    return await rpc.getBlock(hash);
}

const getTransaction = async (txid) => {
    return await rpc.decodeRawTransaction(await rpc.getRawTransaction(txid));
}

const sleep = async (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const main = async () => {
    let info = await rpc.getBlockchainInfo();
    let latestInsertedBlock = await getLatestInsertedBlockNumber();
    let lastBlockNumberProcessed = await getLastBlockNumberProcessed();

    //lastBlockNumberProcessed = 655311; // testing data - remove

    console.log('best block:', info.blocks, 'latest inserted block:', latestInsertedBlock, 'last block processed:', lastBlockNumberProcessed);

    for (let height = lastBlockNumberProcessed; height < info.blocks; height++) {
	console.log('processing block', height);
	const block = await getBlock(height);
	console.log('  ', block.hash, 'transactions:', block.tx.length);

	// TODO: detect miner loss

	// TODO: save block (we will update the block with transactional losses later - need the block first so we can save transactions against it)

	for (let t=0; t<block.tx.length; t++) { // check each transaction in the block for loss
	    let tx = await getTransaction(block.tx[t]);
	    console.log('    ', tx.txid, 'inputs:', tx.vin.length, 'outputs:', tx.vout.length);

	    tx.loss = false;
	    tx.output_value = BigInt(0);
	    for (let o=0; o<tx.vout.length; o++) {
		tx.vout[o].value_int = BigInt(Math.round(tx.vout[o].value * 100000000));
		tx.output_value += tx.vout[o].value_int;
		if (tx.vout[o].value > 0 && tx.vout[o].scriptPubKey.asm.startsWith('OP_RETURN ')) {
		    tx.loss = true;
		    tx.vout[o].loss = true;
		    tx.vout[o].description = 'This output is unspendable because the script starts with OP_RETURN.';
		}
	    }

	    // if we detected loss, materialize all the inputs and save the transaction
	    if (tx.loss) {
		console.log('       LOSS DETECTED - saving transaction');
		// materialize everything needed to save transaction
		tx.block_number = height;
		tx.inputs = [];
	    	for (let i=0; i<tx.vin.length; i++) // find the value of all the inputs
		    tx.inputs.push(await getOutput(tx.vin[i].txid, tx.vin[i].vout));

		tx.input_value = BigInt(0);
	    	for (let i=0; i<tx.inputs.length; i++) // add up all the inputs
		    tx.input_value += BigInt(Math.round(tx.inputs[i].value * 100000000));

		tx.fee = tx.input_value - tx.output_value;

		await upsertTransaction(tx);
		await upsertInputs(tx.txid, tx.inputs);
		await upsertOutputs(tx.txid, tx.vout);

		// TODO: update block to include any transactional loss summary

		await insertLog('inserted transaction', tx.txid);

	    }

	}

	await sleep(1000);
    }

    db.close();
}

main();
