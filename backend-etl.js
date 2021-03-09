const fs = require('fs');
const db = require('./db');
const config = require('./config');
const detectors = require('./detectors');
const { spawn } = require('child_process');
const { chunksToLinesAsync } = require('@rauschma/stringio');

const allowedSupply = (height) => {
    let reward = 5000000000n;   // 50 BTC
    for (let x=1; x<(BigInt(height) / 210000n) + 1n; x++)
        reward = reward / 2n;

    return reward;
}

const processBlock = async (new_block, current_block) => {
    if (current_block) {
	current_block.supply_loss = current_block.transactional_loss > 0n || detectors.blockLoss(current_block);
	if (current_block.number > 0) {
	    const previous_block = await db.getBlock(current_block.number - 1);
	    current_block.current_total_supply = BigInt(previous_block.current_total_supply) + BigInt(current_block.new_supply);
	}
	else
	    current_block.current_total_supply = BigInt(current_block.new_supply);

	await db.upsertBlock(current_block);
	await db.commit();
    }

    new_block.input_sum = 0n;
    new_block.output_sum = 0n,
    new_block.fee_sum = 0n;
    new_block.transactional_loss = 0n;
    new_block.allowed_supply = allowedSupply(new_block.number);

    await db.begin();
    await db.upsertBlock(new_block);

    return new_block;

}

const processTransaction = async (tx, block) => {
    let loss_in_this_transaction = 0n;

    for (let t=0; t<tx.inputs.length; t++)
	block.input_sum += BigInt(tx.inputs[t].value);

    for (let t=0; t<tx.outputs.length; t++) {
	if (tx.outputs[t].value > 0) {
	    if (detectors.outputLoss(block, tx, tx.outputs[t])) {
		tx.outputs[t].supply_loss = true;
		loss_in_this_transaction += BigInt(tx.outputs[t].value);
	    }
	    else
		block.output_sum += BigInt(tx.outputs[t].value);
	}
    }

    block.fee_sum += BigInt(tx.fee);

    block.new_supply = block.output_sum - block.input_sum;
    block.transactional_loss += loss_in_this_transaction;

    if (loss_in_this_transaction > 0n) {
	await db.upsertTransaction(tx);
	await db.upsertInputs(tx.hash, tx.inputs);
	await db.upsertOutputs(tx.hash, tx.outputs);
    }

    return block;

}

const processReadable = async (readable) => {
    let current_block;

    await db.begin();

    for await (const line of chunksToLinesAsync(readable)) {
	readable.pause()
	try {
	    const o = JSON.parse(line);

	    if (o.type == 'block')
		current_block = await processBlock(o, current_block);
	    else if (o.type == 'transaction')
		current_block = await processTransaction(o, current_block);

	}
	catch (e) {
	    console.error(e);
	}
	readable.resume();

    }
}

const launchBitcoinETL = async (startblock) => {
    const providerURI = `http://${config.bitcoinRPC.username}:${config.bitcoinRPC.password}@${config.bitcoinRPC.host}:${config.bitcoinRPC.port}`;

    try {
	fs.unlinkSync('last_synced_block.txt');
    }
    catch (e) {
    }

    const bitcoinetl = spawn('bitcoinetl', [
	'stream', '--chain', 'bitcoin',
	'--start-block', startblock,
	'--block-batch-size', 1, // we depend on getting one block's transactions at a time in the stream
	'--provider-uri', providerURI
    ], { stdio: ['ignore', 'pipe', process.stderr]} );

    await processReadable(bitcoinetl.stdout);

}

const main = async () => {
    await db.connect();

    let start_block = process.argv[2];
    if (!start_block)
	start_block = await db.getLatestBlock() + 1;

    //start_block = 124724; // Miner block loss
    //start_block = 640862; // OP_RETURN tx loss
    //start_block = 150951; // MtGox tx loss

    console.log('starting at block number', start_block);
    launchBitcoinETL(start_block);

}

main();
