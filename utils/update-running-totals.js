const db = require('../db');
const config = require('../config');

// recalculate current_total_supply starting from block 0

const main = async () => {
    await db.connect();
    const latest_block = await db.getLatestBlock();
    let previous_block = {current_total_supply: 0n};

    for (let block_number = 0; block_number <= latest_block; block_number++) {
	const block = await db.getBlock(block_number);
	block.current_total_supply = previous_block.current_total_supply + BigInt(block.new_supply);
	await db.upsertBlock(block);
	previous_block = block;
    }
    await db.end();

}

main();
