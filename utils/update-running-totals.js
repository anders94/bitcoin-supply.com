const db = require('../db');
const config = require('../config');

// recalculate current_total_supply starting from block 0

const main = async (start) => {
    await db.connect();
    const latest_block = await db.getLatestBlock();
    let previous_block = {current_total_supply: 0n};

    for (let block_number = start; block_number <= latest_block; block_number++) {
	const block = await db.getBlock(block_number);
	block.current_total_supply = previous_block.current_total_supply + BigInt(block.new_supply);
	await db.upsertBlock(block);
	previous_block = block;
    }
    await db.end();

}

const start = process.argv[2] ? Number(process.argv[2]) : 0;
main(start);
