const db = require('../db');
const config = require('../config');
const bigInt = require('big-integer');
const {BigQuery} = require('@google-cloud/bigquery');

process.env.GOOGLE_APPLICATION_CREDENTIALS = '../env/google-cloud-creds.json';

const bigquery = new BigQuery();

const getLastBlockNumber = async () => {
    const block = await db.query(`SELECT block_number FROM transactions ORDER BY block_number DESC LIMIT 1`);

    if (block.rows[0])
	return block.rows[0].block_number;
    else
	return 0;

}

const getOpReturnLosses = async (block_number, latest_block) => {
    const query = `
        SELECT 
          *
        FROM
          \`bigquery-public-data.crypto_bitcoin.transactions\` AS t,
          t.outputs AS o
        WHERE o.script_asm LIKE 'OP_RETURN %'
          AND o.value > 0
          AND t.block_number >= ${block_number}
          AND t.block_number <= ${latest_block}
        ORDER BY t.block_number ASC;`;

    const [job] = await bigquery.createQueryJob({query: query, location: 'US'});
    console.log(`OP_RETURN losses: Job ${job.id} started.`);

    let [rows] = await job.getQueryResults();

    for (let r=0; r<rows.length; r++) {
	for (let o=0; o<rows[r].outputs.length; o++) {
	    rows[r].outputs[o].loss = rows[r].outputs[o].script_asm.startsWith('OP_RETURN ');
	    if (rows[r].outputs[o].loss)
		rows[r].outputs[o].description = 'The script used in this output makes it unspendable because it starts with OP_RETURN.';
	}
    }

    return rows;
};

const removeTransactionsFrom = async (block_number, latest_block) => {
    console.log('removing transactions associated with blocks from', block_number, 'and', latest_block);

    const txs = await db.query(
	`SELECT tx_hash
         FROM transactions
         WHERE block_number >= $1
           AND block_number <= $2
         ORDER BY block_number ASC`,
	[block_number, latest_block]);

    for (let t=0; t<txs.rows.length; t++) {
	const tx_hash = txs.rows[t].tx_hash;
	//console.log('  removing inputs for', tx_hash);
	await db.query(`DELETE FROM inputs WHERE tx_hash = $1`, [tx_hash]);
	//console.log('  removing outputs for', tx_hash);
	await db.query(`DELETE FROM outputs WHERE tx_hash = $1`, [tx_hash]);
	console.log('removing', tx_hash);
	await db.query(`DELETE FROM transactions WHERE tx_hash = $1`, [tx_hash]);
    }

};

const upsertTransaction = async (row) => {
    console.log('  adding tx', row.hash);

    await db.query(`
      INSERT INTO transactions (
        block_number, tx_hash, tx_size, virtual_size, version,
        lock_time, is_coinbase, input_value, output_value, fee
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
      )
      ON CONFLICT (tx_hash) DO
        UPDATE SET
          block_number = $1, tx_size = $3, virtual_size = $4, version = $5, lock_time = $6,
          is_coinbase = $7, input_value = $8, output_value = $9, fee = $10`,
		   [row.block_number, row.hash, row.size, row.virtual_size, row.version,
		    row.lock_time, row.is_coinbase, row.input_value ? row.input_value.toString() : null,
		    row.output_value ? row.output_value.toString() : null, row.fee ? row.fee.toString() : null]);
    for (let i=0; i<row.inputs.length; i++) {
	const input = row.inputs[i];
	console.log('    adding input', input.index, input.value.toString());
	await db.query(`
          INSERT INTO inputs (
            tx_hash, input_index, spent_transaction_hash, spent_output_index, script_asm,
            script_hex, input_sequence, required_signatures, input_type, addresses, input_value
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
          )`, [row.hash, input.index, input.spent_transaction_hash, input.spent_output_index,
	       input.script_asm, input.script_hex, input.sequence, input.required_signatures,
	       input.type, input.addresses, input.value.toString()]);
    }
    
    for (let i=0; i<row.outputs.length; i++) {
	const output = row.outputs[i];
	console.log('    adding output', output.index, output.value.toString(), output.script_asm);
	await db.query(`
          INSERT INTO outputs (
            tx_hash, loss, output_index, script_asm, script_hex, required_signatures,
            output_type, addresses, output_value, description
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
          )`, [row.hash, output.loss, output.index, output.script_asm, output.script_hex,
	       output.required_signatures, output.type, output.addresses, output.value.toString(),
	       output.description]);
    }

};

const main = async () => {
    const start_block = await getLastBlockNumber();
    const end_block = 9999999999;

    console.log(`OP_RETURN losses: Starting at block ${start_block} through ${end_block}.`);
    const opReturnLosses = await getOpReturnLosses(start_block, end_block);

    console.log(`Cleaning up transactions from block ${start_block} through ${end_block}.`);
    await removeTransactionsFrom(start_block, end_block);

    console.log('Rows:', opReturnLosses.length);
    for (let r=0; r<opReturnLosses.length; r++) {
	await upsertTransaction(opReturnLosses[r]);
    };
    db.close();

    console.log('done inserting', opReturnLosses.length, 'transactions');

};

main();
