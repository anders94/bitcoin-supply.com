const createError = require('http-errors');
const helpers = require('../helpers');
const express = require('express');
const router = express.Router();
const { check, validationResult } = require('express-validator');
const moment = require('moment');
const db = require('../db');
const config = require('../config');

router.get('/', async (req, res, next) => {
    const losses = await db.query(
        `SELECT *
         FROM blocks
         WHERE anomoly = true
         ORDER BY block_number ASC
         LIMIT 50`);

    const total_lost = await db.query(
	`SELECT SUM(allowed_supply) - SUM(new_supply) AS lost
         FROM blocks
         where anomoly = true`);

    return res.render('index', { title: 'Bitcoin Supply', losses: losses.rows, total_lost: total_lost.rows[0].lost });
});

router.get('/losses', async (req, res, next) => {
    const losses = await db.query(
        `SELECT *
         FROM blocks
         WHERE anomoly = true
         ORDER BY block_number ASC`);

    return res.render('losses', { title: 'Losses | Bitcoin Supply', losses: losses.rows });
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
