const db = require('../db');
const config = require('../config');

const main = async (block_number) => {
    const blockRes = await db.query(
        `SELECT *
         FROM blocks
         WHERE block_number = $1`,
	[block_number]);

    console.log(blockRes.rows[0]);

    db.close();
};

if (process.argv.length == 3)
    main(Number(process.argv[2]));
else
    console.log('usage: node get-block <block number>');
