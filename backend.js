const config = require('./config');
const db = require('./db');
const { spawn } = require('child_process');
const { chunksToLinesAsync } = require('@rauschma/stringio');

const getNextBlockNumberToProcess = async () => {
    const res = await db.query(
        `SELECT block_number + 1 AS block_number
         FROM blocks
         WHERE output_sum IS NOT NULL
         ORDER BY block_number DESC
         LIMIT 1`);

    if (res.rows[0])
        return res.rows[0].block_number;
    else
        return 0;

}

const allowedSupply = (height) => {
    let reward = 5000000000n;   // 50 BTC
    for (let x=1; x<(BigInt(height) / 210000n) + 1n; x++)
        reward = reward / 2n;

    return reward;
}

/*
{"type":"block","hash":"00000000000000000004c2ee79f365ed58701d7537f219e888a83e37be204e69","size":1222895,"stripped_size":925282,"weight":3998741,"number":658926,"version":536870912,"merkle_root":"33d27190f2be2033090a00b3b131314584dd46532ebe42c669534bbce219481f","timestamp":1606493398,"nonce":"2e71e240","bits":"170ffedd","coinbase_param":"03ee0d0a2cfabe6d6d517d23ff791a166bd7b89df715bf09740544962eba9c8940445723954a6e2d4110000000f09f909f082f4632506f6f6c2f0f4d696e656420627920686c377431370000000000000000000000000000000000000000050035f80000","transaction_count":3034,"item_id":"block_00000000000000000004c2ee79f365ed58701d7537f219e888a83e37be204e69"}
 */
const upsertBlock = async (block) => {
    console.log('add block', block.number, new Date(block.timestamp * 1000));
    await db.query(
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
	 allowedSupply(block.number), block.new_supply, block.current_total_supply, 210000n - (BigInt(block.number) % 210000n),
	 block.supply_loss ? true : false, block.attributes ? block.attributes : {}]);
}

const updateBlockSums = async (block_number, input_sum, output_sum, fee_sum) => {
    //console.log('updating block', block_number, '- input sum:', input_sum, 'output sum:', output_sum, 'fee sum:', fee_sum);
    await db.query(
        `UPDATE blocks
         SET
           input_sum = $2,
           output_sum = $3,
           fee_sum = $4
         WHERE
           block_number = $1`,
	[block_number, input_sum, output_sum, fee_sum]);
}
    
const upsertInputs = async (txhash, inputs) => {
    console.log('    upsertInputs(', txhash, ',', inputs.length);
    for (let i=0; i<inputs.length; i++) {
        const input = inputs[i];

	console.log('    add input', txhash, input.index);
        await db.query(
            `DELETE
             FROM inputs
             WHERE tx_hash = $1
               AND input_index = $2`,
            [txhash, input.index]);

        await db.query(
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
}

const upsertOutputs = async (txhash, outputs) => {
    console.log('    upsertOutputs(', txhash, ',', outputs.length);
    for (let o=0; o<outputs.length; o++) {
        const output = outputs[o];

	console.log('    add output', txhash, output.index);
        await db.query(
            `DELETE
             FROM outputs
             WHERE tx_hash = $1
               AND output_index = $2`,
            [txhash, output.index]);

        await db.query(
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
}

/*
coinbase tx
{"type":"transaction","hash":"0afe496889fcfff35afc4a1470c41e3f26821953279b53f7b420d777e2d77c22","size":377,"virtual_size":350,"version":1,"lock_time":1056619958,"block_number":658926,"block_hash":"00000000000000000004c2ee79f365ed58701d7537f219e888a83e37be204e69","block_timestamp":1606493398,"is_coinbase":true,"index":0,"inputs":[],"outputs":[{"index":0,"script_asm":"OP_DUP OP_HASH160 c825a1ecf2a6830c4401620c3a16f1995057c2ab OP_EQUALVERIFY OP_CHECKSIG","script_hex":"76a914c825a1ecf2a6830c4401620c3a16f1995057c2ab88ac","required_signatures":1,"type":"pubkeyhash","addresses":["1KFHE7w8BhaENAswwryaoccDb6qcT6DbYY"],"value":697449754},{"index":1,"script_asm":"OP_RETURN aa21a9ed5ce176613b89218e9c6f3ae334b82348f584e93cb2e9bffdb25ac4a3e1bbd41d 0000000000000000","script_hex":"6a24aa21a9ed5ce176613b89218e9c6f3ae334b82348f584e93cb2e9bffdb25ac4a3e1bbd41d080000000000000000","required_signatures":null,"type":"nonstandard","addresses":["nonstandarda9a0515476f91a684507298800e83b8f47b0eb2f"],"value":0},{"index":2,"script_asm":"OP_RETURN 52534b424c4f434b3a8ef171c63fc89af9b29435dcc0b43457168fcc7fdbb5c193630f9e28002c3487","script_hex":"6a4c2952534b424c4f434b3a8ef171c63fc89af9b29435dcc0b43457168fcc7fdbb5c193630f9e28002c3487","required_signatures":null,"type":"nonstandard","addresses":["nonstandard7322b4f0d231a5e0e081e9b2ebf03a2c152fc9e7"],"value":0},{"index":3,"script_asm":"OP_RETURN b9e11b6d820b6b654149231603f8a6f56ca953fd64b9d29f4b07e075c6436f5c2796a00b","script_hex":"6a24b9e11b6d820b6b654149231603f8a6f56ca953fd64b9d29f4b07e075c6436f5c2796a00b","required_signatures":null,"type":"nonstandard","addresses":["nonstandard118ac64fad5eb4c2c2a3f483da4148bc82c60115"],"value":0}],"input_count":0,"output_count":4,"input_value":0,"output_value":697449754,"fee":0,"item_id":"transaction_0afe496889fcfff35afc4a1470c41e3f26821953279b53f7b420d777e2d77c22"}

regular tx
{"type":"transaction","hash":"c7276e0c7c23ae1710755dd427de471c33d1bf8a1858cd580997922c1ca5f6b6","size":255,"virtual_size":255,"version":1,"lock_time":0,"block_number":658926,"block_hash":"00000000000000000004c2ee79f365ed58701d7537f219e888a83e37be204e69","block_timestamp":1606493398,"is_coinbase":false,"index":1,"inputs":[{"index":0,"spent_transaction_hash":"13fcc406152c7770d2a8cd52079c472af4b7db7fefcfd07bd7f6428f0202c142","spent_output_index":1,"script_asm":"30440220485a6bd981338d752f73bc2cb8588324706f74d9363fa1dc0286cb756cfd36ec02207cdfde05e3958c812f7277905b6d2a32235a7bc38f79b8928a6fd16e10535f70[ALL] 04c4b7a7f7bb2c899f4aeab75b41567c040ae79506d43ee72f650c95b6319e47402f0ba88d1c5a294d075885442679dc24882ea37c31e0dbc82cfd51ed185d7e94","script_hex":"4730440220485a6bd981338d752f73bc2cb8588324706f74d9363fa1dc0286cb756cfd36ec02207cdfde05e3958c812f7277905b6d2a32235a7bc38f79b8928a6fd16e10535f70014104c4b7a7f7bb2c899f4aeab75b41567c040ae79506d43ee72f650c95b6319e47402f0ba88d1c5a294d075885442679dc24882ea37c31e0dbc82cfd51ed185d7e94","sequence":4294967295,"required_signatures":1,"type":"pubkeyhash","addresses":["1CUTyyxgbKvtCdoYmceQJCZLXCde5akiX2"],"value":276302503}],"outputs":[{"index":0,"script_asm":"OP_HASH160 4497e2ae584aa1c0cb2c336e715c906bb185fc28 OP_EQUAL","script_hex":"a9144497e2ae584aa1c0cb2c336e715c906bb185fc2887","required_signatures":1,"type":"scripthash","addresses":["37whpmxKVcRGchZgg6KgeTS3p2yyjUTJMH"],"value":4939429},{"index":1,"script_asm":"OP_DUP OP_HASH160 7ddb236e7877d5040e2a59e4be544c65934e573a OP_EQUALVERIFY OP_CHECKSIG","script_hex":"76a9147ddb236e7877d5040e2a59e4be544c65934e573a88ac","required_signatures":1,"type":"pubkeyhash","addresses":["1CUTyyxgbKvtCdoYmceQJCZLXCde5akiX2"],"value":271163074}],"input_count":1,"output_count":2,"input_value":276302503,"output_value":276102503,"fee":200000,"item_id":"transaction_c7276e0c7c23ae1710755dd427de471c33d1bf8a1858cd580997922c1ca5f6b6"}
 */
const upsertTransaction = async (tx) => {
    console.log('  add transaction', tx.hash);
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
        [tx.block_number, tx.hash, tx.size, tx.virtual_size,
         tx.version, tx.lock_time, tx.is_coinbase ? true : false,
         tx.input_value, tx.output_value, tx.fee]);

    await upsertInputs(tx.hash, tx.inputs);
    await upsertOutputs(tx.hash, tx.outputs);

};

const processReadable = async (readable) => {
    let last_block_number;
    let stats = [];
    for await (const line of chunksToLinesAsync(readable)) {
	readable.pause()
	try {
	    const o = JSON.parse(line);

	    if (o.type == 'block') {
		if (last_block_number) {
		    await updateBlockSums(last_block_number,
					  stats[last_block_number].input_sum,
					  stats[last_block_number].output_sum,
					  stats[last_block_number].fee_sum,);
		    last_block_number = null;
		}

		stats[o.number] = {input_sum: 0n, output_sum: 0n, fee_sum: 0n};
		await upsertBlock(o);
	    }
	    else if (o.type == 'transaction') {
		if (!last_block_number)
		    last_block_number = o.block_number;

		if (last_block_number != o.block_number) {
		    await updateBlockSums(last_block_number,
					  stats[last_block_number].input_sum,
					  stats[last_block_number].output_sum,
					  stats[last_block_number].fee_sum,);
		    last_block_number = o.block_number;
		}

		let input_sum = 0n;
		for (let i=0; i<o.inputs.length; i++)
		    input_sum += BigInt(o.inputs[i].value);

		let output_sum = 0n;
		let lossDetected = false;
		for (let i=0; i<o.outputs.length; i++) {
		    output_sum += BigInt(o.outputs[i].value);
		    if (o.outputs[i].value > 0) {
			if (o.outputs[i].script_asm.startsWith('OP_RETURN ') // OP_RETURN losses
			    || o.outputs[i].script_hex == '76a90088ac') {    // MtGox error
			    o.supply_loss = true;
			    lossDetected = true;
			}
		    }
		}

		stats[o.block_number].input_sum += input_sum;
		stats[o.block_number].output_sum += output_sum;
		if (!o.is_coinbase)
		    stats[o.block_number].fee_sum += input_sum - output_sum;

	    	if (lossDetected)
		    await upsertTransaction(o);

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
	'--block-batch-size', 250,
	'--provider-uri', 'http://bitcoin-supply:6f5b6a90aaca576537350ec080d9f1c7@box.internal.andrs.dev:8332'
    ], { stdio: ['ignore', 'pipe', process.stderr]} );

    await processReadable(bitcoinetl.stdout);

}

const sleep = async (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));

}

const main = async () => {
    const next_block_number_to_process = await getNextBlockNumberToProcess();
    //const next_block_number_to_process = 656798;
    console.log('starting at block number', next_block_number_to_process);
    launchBitcoinETL(next_block_number_to_process);

}

main();
