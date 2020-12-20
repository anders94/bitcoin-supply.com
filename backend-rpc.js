const db = require('./db');
const detectors = require('./detectors');
const { spawn } = require('child_process');
const { chunksToLinesAsync } = require('@rauschma/stringio');

const allowedSupply = (height) => {
    let reward = 5000000000n;   // 50 BTC
    for (let x=1; x<(BigInt(height) / 210000n) + 1n; x++)
        reward = reward / 2n;

    return reward;
}

const processBlock = async (next_block, last_block) => {
    if (last_block) {
	last_block.supply_loss = last_block.transactional_loss > 0n || detectors.blockLoss(last_block);

	await db.upsertBlock(last_block);
	await db.commit();
    }

    next_block.input_sum = 0n;
    next_block.output_sum = 0n,
    next_block.fee_sum = 0n;
    next_block.transactional_loss = 0n;
    next_block.allowed_supply = allowedSupply(next_block.number);

    await db.begin();
    await db.upsertBlock(next_block);

    return next_block;

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

    await db.upsertTransaction(tx);

    if (loss_in_this_transaction > 0n) {
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
    const bitcoinetl = spawn('bitcoinetl', [
	'stream', '--chain', 'bitcoin',
	'--start-block', startblock,
	'--block-batch-size', 1, // we depend on getting one block's transactions at a time in the stream
	'--provider-uri', 'http://bitcoin-supply:6f5b6a90aaca576537350ec080d9f1c7@box.internal.andrs.dev:8332'
    ], { stdio: ['ignore', 'pipe', process.stderr]} );

    await processReadable(bitcoinetl.stdout);

}

const main = async () => {
    await db.connect();

    const start_block = await db.getLatestBlock() + 1;
    //const start_block = 124724; // Miner block loss
    //const start_block = 640862; // OP_RETURN tx loss
    //const start_block = 150951; // MtGox tx loss

    console.log('starting at block number', start_block);
    launchBitcoinETL(start_block);

}

main();
