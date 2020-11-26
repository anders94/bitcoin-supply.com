const createError = require('http-errors');
const helpers = require('../helpers');
const express = require('express');
const router = express.Router();
const { check, validationResult } = require('express-validator');
const moment = require('moment');
const db = require('../db');
const config = require('../config');

router.get('/', async (req, res, next) => {
    const current_supply = await db.query(
	`SELECT SUM(new_supply) AS supply
         FROM blocks`);

    const total_lost = await db.query(
	`SELECT SUM(allowed_supply) - SUM(new_supply) AS lost
         FROM blocks
         WHERE loss = true`);

    const losses = await db.query(
        `SELECT *
         FROM blocks
         WHERE loss = true
         ORDER BY block_number ASC
         LIMIT 50`);

    const latest = await db.query(
        `SELECT *
         FROM blocks
         ORDER BY block_number DESC
         LIMIT 1`);

    const total_possible_supply = BigInt(2099999997690000n)-BigInt(total_lost.rows[0].lost);

    return res.render('index', {
	title: 'Bitcoin Supply',
	current_supply: current_supply.rows[0].supply,
	total_lost: total_lost.rows[0].lost,
	total_possible_supply: total_possible_supply.toString(),
	latest_block: latest.rows[0],
	losses: losses.rows
    });
});

router.get('/losses', async (req, res, next) => {
    return res.redirect('/losses/0');
});

router.get('/losses/:page', [check('page', 'Sorry, the page number must be a positive integer.').trim().isInt({gt: -1})], async (req, res, next) => {
    const errors = validationResult(req);
    if (errors.isEmpty()) {
	const { page } = req.params;
	const losses = await db.query(
            `SELECT *
             FROM blocks
             WHERE loss = true
             ORDER BY block_number ASC
             LIMIT $1
             OFFSET $2`,
	    [config.paginationSize, config.paginationSize*page]);

	const totalRes = await db.query(
            `SELECT COUNT(*) AS total
             FROM blocks
             WHERE loss = true`);

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
    else
	return res.render('error', {
	    message: 'Whoops! That doesn\'t look right.',
	    error: {
		status: 'Must be a positive integer.',
		stack: 'Please enter a positive integer.'
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
            `SELECT *
             FROM blocks
             WHERE block_number <= $1
             ORDER BY block_number DESC
             LIMIT 1`,
            [block_number]);

	if (block.rows[0]) {
	    if (block.rows[0].block_number == block_number)
		return res.render('block', {title: 'Block '+helpers.format(block_number)+' | Bitcoin Supply', block: block.rows[0]});
	    else {
		let theroreticalBlock = {block_number: block_number};
		const blocksAhead = block_number - block.rows[0].block_number;
		theroreticalBlock.block_timestamp = moment(block.rows[0].block_timestamp).add(10 * blocksAhead, 'minutes').format();
		theroreticalBlock.allowed_supply = helpers.allowed_supply(block_number);
		//theroreticalBlock.current_total_supply = 0;
		theroreticalBlock.blocks_till_halving = 210000 - block_number % 210000;
		return res.render('theroretical-block', {title: 'Block '+helpers.format(block_number)+' (unmined) | Bitcoin Supply',
							 block_number: block_number, block: theroreticalBlock});
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

module.exports = router;
