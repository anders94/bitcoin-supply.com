import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { marked } from 'marked';
import { pool } from '../db/index.js';
import { getAllSnapshots } from '../db/snapshots.js';
import { getRawTransaction, getBlockHash, getBlock, getBlockCount } from '../services/bitcoin-rpc.js';
import { formatBtc, satsToBtc } from '../helpers/format.js';

const router = Router();

// GET / - Homepage
router.get('/', async (req: Request, res: Response) => {
  try {
    const snapshots = await getAllSnapshots();
    const { rows: blockRows } = await pool.query(
      'SELECT block_number, block_timestamp FROM blocks ORDER BY block_number DESC LIMIT 1'
    );
    const latestBlock = blockRows[0];

    // Recent provably lost UTXOs
    const { rows: recentLosses } = await pool.query(`
      SELECT u.tx_hash, u.output_index, u.value_sats, u.block_number,
             u.block_timestamp, u.loss_rules, u.loss_bucket, u.address
      FROM utxos u
      WHERE u.loss_bucket = 1
      ORDER BY u.block_number DESC, u.value_sats DESC
      LIMIT 15
    `);

    const dormancyCurve = [1, 3, 5, 7, 10, 15, 20].map(years => {
      const snap = snapshots[`dormant_${years}y`];
      return snap ? { years, total_sats: snap.total_sats.toString() } : { years, total_sats: '0' };
    });

    res.render('index', {
      title: 'bitcoin supply',
      latestBlock,
      provably_lost_sats: (snapshots['provably_lost']?.total_sats ?? 0n).toString(),
      probably_lost_sats: (snapshots['probably_lost']?.total_sats ?? 0n).toString(),
      all_utxos_sats: (snapshots['all_utxos']?.total_sats ?? 0n).toString(),
      quantum_total_sats: (snapshots['quantum_all_exposed']?.total_sats ?? 0n).toString(),
      dormancy_curve: JSON.stringify(dormancyCurve),
      recent_losses: recentLosses,
      formatBtc,
      satsToBtc,
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', message: 'Failed to load homepage', code: 500 });
  }
});

// GET /block/:n - Block detail
router.get('/block/:n', async (req: Request, res: Response) => {
  try {
    const blockNum = parseInt(req.params['n']);
    if (isNaN(blockNum)) {
      return res.status(400).render('error', { title: 'Error', message: 'Invalid block number', code: 400 });
    }

    const { rows: blockRows } = await pool.query(
      'SELECT * FROM blocks WHERE block_number = $1', [blockNum]
    );
    if (!blockRows.length) {
      return res.status(404).render('error', { title: 'Not Found', message: `Block ${blockNum} not found`, code: 404 });
    }
    const blockRecord = blockRows[0];

    // Get loss UTXOs in this block
    const { rows: lossUtxos } = await pool.query(`
      SELECT tx_hash, output_index, value_sats, script_type, address, loss_rules, loss_bucket
      FROM utxos WHERE block_number = $1 AND loss_bucket > 0
      ORDER BY value_sats DESC LIMIT 100
    `, [blockNum]);

    // Miner loss info
    const minerLoss = BigInt(blockRecord.miner_loss_sats);
    const hasMinerLoss = minerLoss > 0n;

    const tipBlock = await getBlockCount();

    res.render('block', {
      title: `Block ${blockNum}`,
      block: blockRecord,
      lossUtxos,
      hasMinerLoss,
      minerLoss: minerLoss.toString(),
      prevBlock: blockNum > 0 ? blockNum - 1 : null,
      nextBlock: blockNum < tipBlock ? blockNum + 1 : null,
      formatBtc,
      satsToBtc,
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', message: 'Failed to load block', code: 500 });
  }
});

// GET /transaction/:hash - Transaction detail
router.get('/transaction/:hash', async (req: Request, res: Response) => {
  try {
    const txHash = req.params['hash'];

    // Fetch from Bitcoin node
    let tx: any;
    try {
      tx = await getRawTransaction(txHash);
    } catch {
      return res.status(404).render('error', { title: 'Not Found', message: 'Transaction not found', code: 404 });
    }

    // Get classified outputs from DB
    const { rows: utxoRows } = await pool.query(`
      SELECT output_index, value_sats, loss_rules, loss_bucket, address, script_type
      FROM utxos WHERE tx_hash = $1
    `, [txHash]);
    const utxoMap: Record<number, any> = {};
    for (const row of utxoRows) utxoMap[row.output_index] = row;

    res.render('transaction', {
      title: `Transaction ${txHash.slice(0, 16)}...`,
      tx,
      utxoMap,
      formatBtc,
      satsToBtc,
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', message: 'Failed to load transaction', code: 500 });
  }
});

// GET /address/:addr - Address detail
router.get('/address/:addr', async (req: Request, res: Response) => {
  try {
    const addr = req.params['addr'];

    const { rows: addrRows } = await pool.query(
      'SELECT * FROM address_info WHERE address = $1', [addr]
    );
    const addrInfo = addrRows[0] || null;

    const { rows: utxos } = await pool.query(`
      SELECT tx_hash, output_index, value_sats, block_number, block_timestamp,
             loss_rules, loss_bucket, pubkey_exposed, script_type
      FROM utxos WHERE address = $1
      ORDER BY value_sats DESC LIMIT 100
    `, [addr]);

    const totalBalance = utxos.reduce((sum: bigint, u: any) => sum + BigInt(u.value_sats), 0n);
    const isQuantumVulnerable = addrInfo?.pubkey_hex != null;

    res.render('address', {
      title: `Address ${addr.slice(0, 20)}...`,
      addr,
      addrInfo,
      utxos,
      totalBalance: totalBalance.toString(),
      isQuantumVulnerable,
      formatBtc,
      satsToBtc,
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', message: 'Failed to load address', code: 500 });
  }
});

// GET /losses - Paginated loss history
router.get('/losses', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query['page'] as string || '1');
    const perPage = 50;
    const offset = (page - 1) * perPage;
    const filterRule = req.query['rule'] as string | undefined;

    let whereClause = 'WHERE loss_bucket > 0';
    const params: any[] = [perPage, offset];
    if (filterRule) {
      whereClause += ` AND loss_rules @> $3`;
      params.push(`{${filterRule}}`);
    }

    const { rows: losses } = await pool.query(`
      SELECT tx_hash, output_index, value_sats, block_number, block_timestamp,
             loss_rules, loss_bucket, address
      FROM utxos ${whereClause}
      ORDER BY block_number DESC, value_sats DESC
      LIMIT $1 OFFSET $2
    `, params);

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) n FROM utxos ${whereClause}`,
      filterRule ? [`{${filterRule}}`] : []
    );
    const total = parseInt(countRows[0].n);
    const totalPages = Math.ceil(total / perPage);

    res.render('losses', {
      title: 'Loss History',
      losses,
      page,
      totalPages,
      filterRule,
      formatBtc,
      satsToBtc,
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', message: 'Failed to load losses', code: 500 });
  }
});

// GET /quantum - Quantum explorer
router.get('/quantum', async (req: Request, res: Response) => {
  try {
    const snapshots = await getAllSnapshots();

    const { rows: topExposed } = await pool.query(`
      SELECT u.address, SUM(u.value_sats) balance, COUNT(*) utxo_count,
             ai.pubkey_hex, ai.pubkey_exposed_at_block,
             BOOL_OR(u.loss_rules @> '{015}') is_p2pk
      FROM utxos u
      LEFT JOIN address_info ai ON ai.address = u.address
      WHERE u.pubkey_exposed = TRUE
      GROUP BY u.address, ai.pubkey_hex, ai.pubkey_exposed_at_block
      ORDER BY balance DESC LIMIT 100
    `);

    res.render('quantum', {
      title: 'Quantum Vulnerability Explorer',
      quantum_p2pk_sats: (snapshots['quantum_p2pk']?.total_sats ?? 0n).toString(),
      quantum_all_sats: (snapshots['quantum_all_exposed']?.total_sats ?? 0n).toString(),
      quantum_p2pk_count: (snapshots['quantum_p2pk']?.utxo_count ?? 0n).toString(),
      topExposed,
      formatBtc,
      satsToBtc,
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', message: 'Failed to load quantum page', code: 500 });
  }
});

// GET /proposals - Proposal index
router.get('/proposals', async (req: Request, res: Response) => {
  try {
    const proposalsDir = path.join(process.cwd(), 'proposals');
    const files = fs.readdirSync(proposalsDir).filter(f => f.endsWith('.md')).sort();

    const proposals = files.map(file => {
      const content = fs.readFileSync(path.join(proposalsDir, file), 'utf8');
      const lines = content.split('\n');
      const title = lines[0]?.replace(/^#+\s*/, '') ?? file;

      // Parse front matter table
      const statusMatch = content.match(/\|\s*Status\s*\|\s*([^|]+)\|/);
      const categoryMatch = content.match(/\|\s*Category\s*\|\s*([^|]+)\|/);
      const scaleMatch = content.match(/\|\s*Scale Estimate\s*\|\s*([^|]+)\|/);

      return {
        id: file.replace('.md', ''),
        file,
        title,
        status: statusMatch ? statusMatch[1].trim() : 'Unknown',
        category: categoryMatch ? categoryMatch[1].trim() : 'Unknown',
        scale: scaleMatch ? scaleMatch[1].trim() : 'TBD',
      };
    });

    res.render('proposals', { title: 'Proposals', proposals });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', message: 'Failed to load proposals', code: 500 });
  }
});

// GET /proposals/:id - Single proposal
router.get('/proposals/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'];
    const proposalsDir = path.join(process.cwd(), 'proposals');
    const files = fs.readdirSync(proposalsDir).filter(f => f.endsWith('.md') && f.startsWith(id));

    if (!files.length) {
      return res.status(404).render('error', { title: 'Not Found', message: 'Proposal not found', code: 404 });
    }

    const content = fs.readFileSync(path.join(proposalsDir, files[0]), 'utf8');
    const html = await marked(content);
    const title = content.split('\n')[0]?.replace(/^#+\s*/, '') ?? id;

    res.render('proposal', { title, content: html });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', message: 'Failed to load proposal', code: 500 });
  }
});

// POST /search - Search by block # or txid
router.post('/search', async (req: Request, res: Response) => {
  try {
    const query = (req.body?.query as string || '').trim();
    if (!query) return res.redirect('/');

    // Check if it looks like a block number
    if (/^\d+$/.test(query)) {
      return res.redirect(`/block/${query}`);
    }

    // Check if it looks like a 64-char hex (txid or block hash)
    if (/^[0-9a-fA-F]{64}$/.test(query)) {
      // Try block hash first
      const { rows } = await pool.query(
        'SELECT block_number FROM blocks WHERE block_hash = $1', [query]
      );
      if (rows.length) {
        return res.redirect(`/block/${rows[0].block_number}`);
      }
      // Assume txid
      return res.redirect(`/transaction/${query}`);
    }

    // Try as address
    const { rows } = await pool.query(
      'SELECT address FROM address_info WHERE address = $1', [query]
    );
    if (rows.length) {
      return res.redirect(`/address/${query}`);
    }

    res.render('error', { title: 'Not Found', message: `Nothing found for: ${query}`, code: 404 });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', message: 'Search failed', code: 500 });
  }
});

// GET /search - handle GET search too
router.get('/search', (req: Request, res: Response) => {
  res.redirect('/');
});

export default router;
