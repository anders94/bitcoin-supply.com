const db = require('../db');
const config = require('../config');

const main = async () => {
    const blocks = await db.query(
        `SELECT *
         FROM blocks
         ORDER BY block_number ASC`);

    let current_total_supply = BigInt(0);
    for (let r=0; r<blocks.rows.length; r++) {
	const row = blocks.rows[r];
	current_total_supply += BigInt(row.new_supply);
	const blocks_till_halving = 210000 - (row.block_number % 210000);
	console.log(row.block_number, row.new_supply, current_total_supply.toString(), blocks_till_halving);
	await db.query(
	    `UPDATE blocks
             SET current_total_supply = $1, blocks_till_halving = $3
             WHERE block_number = $2`,
	    [current_total_supply.toString(), row.block_number, blocks_till_halving]);
    };
    db.close();

};

main();
