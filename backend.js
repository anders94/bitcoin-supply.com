const db = require('./db');
const detectors = require('./detectors');
const { spawn } = require('child_process');
const { chunksToLinesAsync } = require('@rauschma/stringio');

// TODO
//   * make sure block.transactional_loss and block.supply_loss are both set properly
//       select block_number, block_timestamp, transaction_count, input_sum, output_sum, input_sum-output_sum as delta, transactional_loss, allowed_supply, new_supply, current_total_supply, supply_loss from blocks;
//   * actually implement anomolies table
//   * make sure block.new_supply is correct

const allowedSupply = (height) => {
    let reward = 5000000000n;   // 50 BTC
    for (let x=1; x<(BigInt(height) / 210000n) + 1n; x++)
        reward = reward / 2n;

    return reward;
}

const processReadable = async (readable) => {
    const anomolies = await db.getAnomolies();
    let current_block;

    await db.begin();

    for await (const line of chunksToLinesAsync(readable)) {
	readable.pause()
	try {
	    const o = JSON.parse(line);

	    if (o.type == 'block') {
		if (current_block) {
		    await db.upsertBlock(current_block);
		    await db.commit();
		}

		current_block = o;

		current_block.input_sum = 0n;
		current_block.output_sum = 0n,
		current_block.fee_sum = 0n;
		current_block.transactional_loss = 0n;
		current_block.allowed_supply = allowedSupply(o.number)

		await db.begin();
		await db.upsertBlock(current_block);

	    }
	    else if (o.type == 'transaction') {
		current_block.input_sum = 0n;
		for (let i=0; i<o.inputs.length; i++)
		    current_block.input_sum += BigInt(o.inputs[i].value);

		let loss_in_this_transaction = 0n;
		current_block.output_sum = 0n;
		for (let i=0; i<o.outputs.length; i++) {
		    current_block.output_sum += BigInt(o.outputs[i].value);
		    if (o.outputs[i].value > 0) {
			if (detectors.outputLoss(o.outputs[i])) {
			    o.outputs[i].supply_loss = true;
			    loss_in_this_transaction += BigInt(o.outputs[i].value);
			}
		    }
		}
		current_block.fee_sum += BigInt(o.fee);
		current_block.supply_loss = loss_in_this_transaction == 0n ||
		    current_block.input_sum - current_block.output_sum == 0;
		current_block.new_supply = current_block.input_sum - current_block.output_sum;
		current_block.transactional_loss += loss_in_this_transaction;

		await db.upsertTransaction(o);
		if (loss_in_this_transaction) {
		    await db.upsertInputs(tx.hash, tx.inputs);
		    await db.upsertOutputs(tx.hash, tx.outputs);
		}


	    }

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

const sleep = async (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));

}

const main = async () => {
    await db.connect();

    //const start_block = await getLatestBlock() + 1;
    const start_block = 124724; // Miner block loss
    //const start_block = 640862; // OP_RETURN tx loss
    //const start_block = 150951; // MtGox tx loss

    console.log('starting at block number', start_block);
    launchBitcoinETL(start_block);

}

main();
