const createError = require('http-errors');
const helpers = require('../helpers');
const express = require('express');
const router = express.Router();
const { check, validationResult } = require('express-validator');
const { createCanvas, loadImage } = require('canvas');
const moment = require('moment');
const db = require('../db');
const config = require('../config');

let homepageCache = null;

const updateHomepageCache = async () => {
    try {
	if (!db.isConnected())
	    await db.connect();

	const start = new Date().getTime();

        const block = await db.query(
            `SELECT *, allowed_supply - transactional_loss - new_supply as miner_loss
             FROM blocks
             ORDER BY block_number DESC
             LIMIT 1`);

        const total_lost = await db.query(
            `SELECT COALESCE(SUM(allowed_supply), 0) - COALESCE(SUM(new_supply), 0) AS lost
             FROM blocks
             WHERE supply_loss = true`);

        const latest_losses = await db.query(
            `SELECT *
             FROM blocks
             WHERE supply_loss = true
             ORDER BY block_number DESC
             LIMIT 15`);

        const biggest_losses = await db.query(
            `SELECT *
             FROM blocks
             WHERE supply_loss = true
             ORDER BY allowed_supply - new_supply DESC, block_number ASC
             LIMIT 15`);

        const total_possible_supply = BigInt(2099999997690000n)-BigInt(total_lost.rows[0].lost);

        homepageCache = {
            block: block.rows[0],
            total_lost: total_lost.rows[0].lost,
            latest_losses: latest_losses.rows,
            biggest_losses: biggest_losses.rows,
            total_possible_supply: total_possible_supply.toString()
        };

        console.log('Homepage cache updated in', new Date().getTime() - start, 'ms');

    }
    catch (error) {
        console.error('Error updating homepage cache:', error);

    }

}

updateHomepageCache();
setInterval(updateHomepageCache, 60 * 1000);

router.get('/', async (req, res, next) => {
    const cachedData = homepageCache;

    if (!cachedData) {
        return res.render('startup');
    }

    return res.render('index', cachedData);
});

router.get('/img/image.png', async (req, res, next) => {
    const width = 768;
    const height = 403;

    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');

    const block = await db.query(
        `SELECT *
         FROM blocks
         ORDER BY block_number DESC
         LIMIT 1`);

    const total_lost = await db.query(
	`SELECT COALESCE(SUM(allowed_supply), 0) - COALESCE(SUM(new_supply), 0) AS lost
         FROM blocks
         WHERE supply_loss = true`);

    const total_possible_supply = BigInt(2099999997690000n)-BigInt(total_lost.rows[0].lost);

    const image = await loadImage('public/images/card-background.png');

    context.drawImage(image, 0, 0, width, height);

    context.fillStyle = '#000000';
    context.font = 'bold 28pt Helvetica';
    context.fillText((block.rows[0].current_total_supply/100000000/1000000).toFixed(3) + ' Million BTC', 310, 140);
    context.fillStyle = '#666666';
    context.font = '14pt Helvetica';
    context.fillText('Current Supply', 310, 176);

    context.fillStyle = '#000000';
    context.font = 'bold 28pt Helvetica';
    context.fillText((Number(total_possible_supply)/100000000/1000000).toFixed(3) + ' Million BTC', 310, 238);
    context.fillStyle = '#666666';
    context.font = '14pt Helvetica';
    context.fillText('Total Expected Supply', 310, 266);

    context.fillStyle = '#000000';
    context.font = 'bold 28pt Helvetica';
    context.fillText(((block.rows[0].current_total_supply / Number(total_possible_supply)) * 100).toFixed(3) + '%', 310, 325);
    context.fillStyle = '#666666';
    context.font = '14pt Helvetica';
    context.fillText('Expected Supply Released', 310, 353);

    context.fillStyle = '#FFFFFF';
    context.font = '9pt Helvetica';
    context.textAlign = 'center';
    context.fillText('As of block ' + block.rows[0].block_number +
		     ' mined ' + block.rows[0].block_timestamp +
		     ' - Bitcoin-Supply.com', width / 2, 390);

    const img = canvas.toBuffer('image/png');

    res.set({'Content-Type': 'image/png'});
    res.set({'Content-Length': img.length});
    res.send(img);

});

router.get('/losses', async (req, res, next) => {
    return res.redirect('/losses/0');
});

router.get('/losses/:page', [check('page', 'Sorry, the page number must be a positive integer.').trim().isInt({gt: -1})], async (req, res, next) => {
    const errors = validationResult(req);
    if (errors.isEmpty()) {
	const { page } = req.params;
	const losses = await db.query(
            `SELECT *, allowed_supply - transactional_loss - new_supply as miner_loss
             FROM blocks
             WHERE supply_loss = true
             ORDER BY block_number ASC
             LIMIT $1
             OFFSET $2`,
	    [config.paginationSize, Number(config.paginationSize) * Number(page)]);

	const totalRes = await db.query(
            `SELECT COUNT(*) AS total
             FROM blocks
             WHERE supply_loss = true`);

	return res.render('losses', {
	    title: 'Losses | Bitcoin Supply',
	    losses: losses.rows,
	    page: page,
	    total: totalRes.rows[0].total,
	    paginationSize: config.paginationSize
	});
    }
    else {
	console.log(errors);
	return res.render('error', {
	    message: 'Whoops! That doesn\'t look right.',
	    error: {
		status: 'Page must be a positive integer.',
		stack: 'The URL does not contain a page numbered with a positive integer..'
	    }
	});
    }
});

router.post('/search', [], (req, res, next) => {
    if (Number.isInteger(Number(req.body.query)))
	return res.redirect('/block/' + req.body.query);
    else if (req.body.query.length == 64 && helpers.isHex(req.body.query))
	return res.redirect('/transaction/' + req.body.query);
    else
	return res.render('error', {
	    message: 'Whoops! Can\'t find what you\'re looking for.',
	    error: {
		status: 'Try a block number or a transaction ID.',
		stack: 'Block numbers are positive integers such as 150951 and transaction IDs are 64 character hexadecimal strings such as 03acfae47d1e0b7674f1193237099d1553d3d8a93ecc85c18c4bec37544fe386.'
	    }
	});
});

router.get('/current', [], async (req, res, next) => {
    const current = await db.query(
        `SELECT block_number
         FROM blocks
         ORDER BY block_number DESC
         LIMIT 1`);

    return res.redirect('/block/'+current.rows[0].block_number);
});

router.get('/block/:block_number', [check('block_number', 'Sorry, a block\'s ID must be a positive integer.').trim().isInt({gt: -1})], async (req, res, next) => {
    const errors = validationResult(req);
    if (errors.isEmpty()) {
	const { block_number } = req.params;

        if (!block_number)
            throw new Error('Missing uuid field');

	const block = await db.query(
            `SELECT *, allowed_supply - transactional_loss - new_supply as miner_loss
             FROM blocks
             WHERE block_number <= $1
             ORDER BY block_number DESC
             LIMIT 1`,
            [block_number]);

	if (block.rows[0]) {
	    if (block.rows[0].block_number == block_number) {
		if (block.rows[0].allowed_supply != block.rows[0].new_supply) {
		    const txs = await db.query(
			`SELECT *,
                           (SELECT SUM(output_value)
                            FROM outputs
                            WHERE tx_hash = t.tx_hash
                              AND supply_loss = TRUE) AS loss 
                         FROM transactions t 
                         WHERE block_number = $1`,
			[block.rows[0].block_number]);
		    return res.render('block', {
			title: 'Block '+helpers.format(block_number)+' | Bitcoin Supply',
			block: block.rows[0],
			transactions: txs.rows
		    });
		}
		else
		    return res.render('block', {
			title: 'Block '+helpers.format(block_number)+' | Bitcoin Supply',
			block: block.rows[0],
			transactions: []
		    });
	    }
	    else {
		let theroreticalBlock = {block_number: block_number};
		const blocksAhead = block_number - block.rows[0].block_number;
		theroreticalBlock.block_timestamp = moment(block.rows[0].block_timestamp).add(10 * blocksAhead, 'minutes').format();
		theroreticalBlock.allowed_supply = helpers.allowed_supply(block_number);
		//theroreticalBlock.current_total_supply = 0;
		theroreticalBlock.blocks_till_halving = 210000 - block_number % 210000;
		return res.render('theroretical-block', {title: 'Block '+helpers.format(block_number)+' (unmined) | Bitcoin Supply',
							 block_number: block_number, block: theroreticalBlock, transactions: []});
	    }
	}
	return res.render('error', {
	    message: 'Whoops! Something doesn\'t look right.',
	    error: {
		status: 'It\'s not you, it\'s us!',
		stack: 'Some sort of internal database error happened. Please check back again later.'
	    }
	});
    }
    else {
	console.log(errors);
	return res.render('error', {
	    message: 'Whoops! That doesn\'t look right.',
	    error: {
		status: 'Must be a positive integer.',
		stack: 'Please enter a positive integer.'
	    }
	});
    }
});

router.get('/transaction/:tx_hash', [check('tx_hash', 'Sorry, that doesn\'t look like a valid transaction hash.').trim().isHexadecimal()], async (req, res, next) => {
    const errors = validationResult(req);
    if (errors.isEmpty()) {
	const { tx_hash } = req.params;

        if (!tx_hash)
            throw new Error('Missing transaction hash');

	const tx = await db.query(
            `SELECT *
             FROM transactions
             WHERE tx_hash = $1`,
            [tx_hash]);

	if (tx.rows[0]) {
	    const inputs = await db.query(
		`SELECT *
                 FROM inputs
                 WHERE tx_hash = $1`,
		[tx_hash]);

	    const outputs = await db.query(
		`SELECT *
                 FROM outputs
                 WHERE tx_hash = $1`,
		[tx_hash]);

	    return res.render('transaction', {
		title: 'Transaction '+tx_hash+' | Bitcoin Supply',
		transaction: tx.rows[0],
		inputs: inputs.rows,
		outputs: outputs.rows
	    });
	}
	else
	    return res.render('error', {
		message: 'Whoops! Doesn\'t look like I have that transaction.',
		error: {
                    status: 'Can\'t find that transaction.',
                    stack: 'The transaction you are referencing either does not exist or isn\'t one we have flagged with supply loss.'
		}
	    });
    }
    else
	return res.render('error', {
	    message: 'Whoops! That doesn\'t look right.',
	    error: {
		status: 'Must be a positive integer.',
		stack: 'Please enter a positive integer.'
	    }
	});
});

module.exports = router;
module.exports.updateHomepageCache = updateHomepageCache;
