const db = require('../db');
const config = require('../config');
const bigInt = require('big-integer');
const {BigQuery} = require('@google-cloud/bigquery');

process.env.GOOGLE_APPLICATION_CREDENTIALS = '../env/google-cloud-creds.json';

const bigquery = new BigQuery();
const main = async () => {
    const oneoffsRes = await db.query(
        `SELECT *
         FROM oneoffs
         ORDER BY block_number ASC`);

    let oneoffs = {};
    for (let r=0; r<oneoffsRes.rows.length; r++)
        oneoffs[oneoffsRes.rows[r].block_number] = oneoffsRes.rows[r];

    const heightRes = await db.query(
        `SELECT block_number
         FROM blocks
         ORDER BY block_number DESC
         LIMIT 1`);

    let block_number = 0;
    if (heightRes.rows[0])
	block_number = Number(heightRes.rows[0].block_number);

    console.log(`Fetching ${block_number-100} through latest block.`);

    const query = `
      SELECT 
         block_number,
         block_timestamp,
         COALESCE(SUM(input_value), 0) AS input_sum,
         COALESCE(SUM(output_value), 0) AS output_sum,
         COALESCE(SUM(fee), 0) AS fees,
         ( SELECT COALESCE(SUM(value), 0)
           FROM \`bigquery-public-data.crypto_bitcoin.outputs\`
           WHERE block_number = block_number
             AND script_asm like 'OP_RETURN%' ) AS transactional_loss,
         COALESCE(SUM(output_value), 0) - COALESCE(SUM(input_value), 0) AS new_supply 
       FROM \`bigquery-public-data.crypto_bitcoin.transactions\`
       WHERE block_number >= ${block_number-100}
       GROUP BY block_number, block_timestamp
       ORDER BY block_number ASC`;

    const [job] = await bigquery.createQueryJob({query: query, location: 'US'});
    console.log(`Job ${job.id} started.`);

    const [rows] = await job.getQueryResults();

    console.log('Rows:', rows.length);
    for (let r=0; r<rows.length; r++) {
        let row = rows[r];
        row.allowed_supply = allowedSupply(row.block_number);
	const blocks_till_halving = 210000 - (row.block_number % 210000);
	row.anomoly = (row.allowed_supply != row.new_supply);
	row.description = '';
	if (oneoffs[row.block_number]) {
	    row.anomoly = true;
	    row.new_supply = oneoffs[row.block_number].new_supply;
	    row.description = oneoffs[row.block_number].description;
	}
	const supplyRes = await db.query(
          `SELECT current_total_supply
           FROM blocks
           WHERE block_number=$1`, [row.block_number-1]);

	const current_total_supply = supplyRes.rows[0] ? BigInt(supplyRes.rows[0].current_total_supply) + BigInt(row.new_supply.toString()) : 0;
	
        console.log(row.block_number + '\t' + JSON.stringify(
	    [row.block_number, row.block_timestamp.value, row.input_sum.toString(), row.output_sum.toString(),
	     row.fees.toString(), row.transactional_loss.toString(), row.allowed_supply, row.new_supply.toString(),
	     current_total_supply.toString(), blocks_till_halving, row.anomoly, row.description]));

	await db.query(
	    `INSERT INTO blocks (
               block_number, block_timestamp, input_sum, output_sum, fees, transactional_loss, allowed_supply,
               new_supply, current_total_supply, blocks_till_halving, anomoly, description
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
             )
             ON CONFLICT (block_number)
             DO
               UPDATE SET
                 block_timestamp=$2, input_sum=$3, output_sum=$4, fees=$5, transactional_loss=$6, allowed_supply=$7,
                 new_supply=$8, current_total_supply=$9, blocks_till_halving=$10, anomoly=$11, description=$12`,
	    [row.block_number, row.block_timestamp.value, row.input_sum.toString(), row.output_sum.toString(),
	     row.fees.toString(), row.transactional_loss.toString(), row.allowed_supply, row.new_supply.toString(),
	     current_total_supply.toString(), blocks_till_halving, row.anomoly, row.description]);

    };
    db.close();

};

const allowedSupply = (height) => {
    const halflife = bigInt(210000);   // 210,000 blocks
    let coinbase = bigInt(5000000000); // 50 BTC

    const block = bigInt(height);
    const halvings = Number(block.divide(halflife).add(1).toString());

    for (let x=1; x<halvings; x++)
        coinbase=coinbase.divide(2);

    return coinbase.toString();
}

main();
