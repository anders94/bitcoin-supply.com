import { Router, Request, Response } from 'express';
import { addressQuantumStatus } from '../db/address-info.js';
import { pool } from '../db/index.js';
import { getComputedStats } from '../db/computed-stats.js';
import { withCache } from '../services/redis.js';
import { addSSEClient } from '../services/sse.js';
import { config } from '../config.js';
import { getCachedRawTransaction } from '../services/tx-data.js';
import { loadBlock } from '../services/block-data.js';
import { subsidyAt } from '../helpers/format.js';
import { bucketLabel, describeRules, money } from '../helpers/loss-describe.js';

const router = Router();

// The per-entity endpoints (/address, /block, /transaction) below are the JSON
// siblings of the deep HTML pages. They deliberately do NOT use withCache: their
// key space is unbounded (every address, every block, every txid), and Redis
// runs with maxmemory=0 / noeviction, so caching them would grow the store until
// writes fail — the exact hazard the page-cache whitelist exists to avoid. They
// carry a short Cache-Control instead, so a browser or future CDN can help
// without putting unbounded keys in Redis. robots.txt disallows /api/ for
// crawlers, so only user-triggered agents reach these.
const ENTITY_CACHE_CONTROL = 'public, max-age=30, stale-while-revalidate=90';

const canonical = (path: string) => config.server.publicUrl + path;

// GET /api/v1/stats
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const data = await withCache('api:stats', 60, async () => {
      const { rows: blockRows } = await pool.query(
        'SELECT block_number, block_timestamp FROM blocks ORDER BY block_number DESC LIMIT 1'
      );
      const latestBlock = blockRows[0];

      const { rows: snapRows } = await pool.query(
        `SELECT snapshot_key, total_sats, utxo_count FROM loss_snapshots
         WHERE snapshot_key IN ('provably_lost', 'probably_lost', 'all_utxos',
                                'quantum_p2pk', 'quantum_p2tr', 'quantum_p2ms',
                                'quantum_exposed_pkh', 'quantum_exposed_script', 'quantum_all_exposed')`
      );

      const snaps: Record<string, any> = {};
      for (const row of snapRows) snaps[row.snapshot_key] = row;

      const allUtxosSats = BigInt(snaps['all_utxos']?.total_sats ?? 0);
      const provablyLostSats = BigInt(snaps['provably_lost']?.total_sats ?? 0);
      const maxSupply = config.maxSupplySats;
      // circulating = all utxos - provably lost
      const circulatingSats = allUtxosSats - provablyLostSats;

      return {
        circulating_supply_sats: circulatingSats.toString(),
        max_supply_sats: maxSupply.toString(),
        all_utxos_sats: allUtxosSats.toString(),
        current_block: latestBlock?.block_number ?? 0,
        tip_timestamp: latestBlock?.block_timestamp ?? null,
        provably_lost_sats: snaps['provably_lost']?.total_sats?.toString() ?? '0',
        probably_lost_sats: snaps['probably_lost']?.total_sats?.toString() ?? '0',
        quantum_p2pk_sats: snaps['quantum_p2pk']?.total_sats?.toString() ?? '0',
        quantum_p2tr_sats: snaps['quantum_p2tr']?.total_sats?.toString() ?? '0',
        quantum_p2ms_sats: snaps['quantum_p2ms']?.total_sats?.toString() ?? '0',
        quantum_exposed_pkh_sats: snaps['quantum_exposed_pkh']?.total_sats?.toString() ?? '0',
        quantum_exposed_script_sats: snaps['quantum_exposed_script']?.total_sats?.toString() ?? '0',
        quantum_all_exposed_sats: snaps['quantum_all_exposed']?.total_sats?.toString() ?? '0',
      };
    });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/loss-spectrum
router.get('/loss-spectrum', async (req: Request, res: Response) => {
  try {
    const maxBucket = parseInt(req.query['max_bucket'] as string || '1');
    const dormantBefore = req.query['dormant_before'] as string | undefined;
    const includeQuantum = req.query['include_quantum'] === 'true';

    const cacheKey = `api:loss-spectrum:${maxBucket}:${dormantBefore || ''}:${includeQuantum}`;

    const data = await withCache(cacheKey, 300, async () => {
      let whereClause = '';
      const params: any[] = [];

      if (maxBucket === 3 && dormantBefore) {
        params.push(dormantBefore);
        // Dormancy includes quantum-tagged P2PK (bucket 4): the quantum tag is
        // an independent lens, not a loss bucket on this axis.
        whereClause = `WHERE (loss_bucket BETWEEN 1 AND 2)
          OR (loss_bucket IN (0, 4) AND block_timestamp <= $1)`;
      } else if (maxBucket >= 1) {
        whereClause = `WHERE loss_bucket BETWEEN 1 AND ${maxBucket}`;
      }

      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(value_sats), 0) total_sats, COUNT(*) utxo_count FROM utxos ${whereClause}`,
        params
      );

      // Breakdown by bucket
      const { rows: breakdown } = await pool.query(`
        SELECT loss_bucket, COALESCE(SUM(value_sats), 0) total_sats, COUNT(*) utxo_count
        FROM utxos WHERE loss_bucket > 0 GROUP BY loss_bucket
      `);

      const bucketMap: Record<number, any> = {};
      for (const row of breakdown) bucketMap[row.loss_bucket] = row;

      let quantumOverlay = null;
      if (includeQuantum) {
        const { rows: qRows } = await pool.query(
          `SELECT COALESCE(SUM(value_sats), 0) total_sats, COUNT(*) utxo_count
           FROM utxos WHERE pubkey_exposed = TRUE AND loss_bucket = 0`
        );
        quantumOverlay = {
          total_sats: qRows[0].total_sats.toString(),
          utxo_count: qRows[0].utxo_count.toString(),
        };
      }

      return {
        total_sats: rows[0].total_sats.toString(),
        utxo_count: rows[0].utxo_count.toString(),
        breakdown: {
          provably: { total_sats: (bucketMap[1]?.total_sats ?? 0).toString(), utxo_count: (bucketMap[1]?.utxo_count ?? 0).toString() },
          probably: { total_sats: (bucketMap[2]?.total_sats ?? 0).toString(), utxo_count: (bucketMap[2]?.utxo_count ?? 0).toString() },
          dormant: { total_sats: '0', utxo_count: '0' }, // computed per request for dormant_before
        },
        quantum_overlay: quantumOverlay,
      };
    });

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/dormancy-curve
router.get('/dormancy-curve', async (req: Request, res: Response) => {
  try {
    const data = await withCache('api:dormancy-curve', 600, async () => {
      const { rows } = await pool.query(
        `SELECT snapshot_key, total_sats, utxo_count, computed_at_block
         FROM loss_snapshots WHERE snapshot_key LIKE 'dormant_%' OR snapshot_key = 'all_utxos'
         ORDER BY snapshot_key`
      );

      const yearOrder = [1, 3, 5, 7, 10, 15, 20];
      const curve = yearOrder
        .map(years => {
          const row = rows.find(r => r.snapshot_key === `dormant_${years}y`);
          return row ? {
            label: `${years}y`,
            years,
            total_sats: row.total_sats.toString(),
            utxo_count: row.utxo_count.toString(),
          } : null;
        })
        .filter(Boolean);

      const allRow = rows.find(r => r.snapshot_key === 'all_utxos');

      return {
        curve,
        all_utxos_sats: allRow?.total_sats?.toString() ?? '0',
      };
    });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/loss-breakdown
router.get('/loss-breakdown', async (req: Request, res: Response) => {
  try {
    const data = await withCache('api:loss-breakdown', 300, async () => {
      // Precomputed hourly by the ETL snapshot job (a live unnest over tens of
      // millions of loss rows is far too slow for request time).
      const stats = await getComputedStats(['rule_breakdown']);
      const rules: any[] = stats['rule_breakdown']?.data?.rules ?? [];
      const miner = stats['rule_breakdown']?.data?.miner_loss;
      const out = rules.map(r => ({
        rule: r.rule,
        total_sats: r.total_sats.toString(),
        utxo_count: r.utxo_count.toString(),
      }));
      if (miner && miner.total_sats !== '0') {
        out.push({ rule: '002', total_sats: miner.total_sats, utxo_count: miner.block_count });
      }
      return out.sort((a, b) => (BigInt(b.total_sats) > BigInt(a.total_sats) ? 1 : -1));
    });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/quantum
router.get('/quantum', async (req: Request, res: Response) => {
  try {
    const data = await withCache('api:quantum', 300, async () => {
      // Per-output totals by how the key became public. From the hourly
      // snapshot, so this agrees with the homepage and /quantum by construction
      // (the old version summed address_info and could disagree with both).
      const { rows: snapRows } = await pool.query(`
        SELECT snapshot_key, total_sats::text, utxo_count::text, computed_at_block
        FROM loss_snapshots WHERE snapshot_key LIKE 'quantum_%'
      `);
      const snaps: Record<string, any> = {};
      for (const r of snapRows) snaps[r.snapshot_key] = r;
      const cat = (key: string) => ({
        total_sats: snaps[key]?.total_sats ?? '0',
        utxo_count: snaps[key]?.utxo_count ?? '0',
      });

      // Address-level view: addresses with a balance, by exposure kind.
      // Legacy rows (pre-migration 008) resolve to p2pk / pkh.
      const { rows: byKind } = await pool.query(`
        SELECT COALESCE(exposure_kind, CASE WHEN is_p2pk THEN 'p2pk' ELSE 'pkh' END) AS kind,
               COUNT(*)::text AS address_count,
               COALESCE(SUM(utxo_value_sats), 0)::text AS total_sats
        FROM address_info WHERE pubkey_exposed = TRUE AND utxo_count > 0
        GROUP BY 1 ORDER BY 1
      `);

      const { rows: top } = await pool.query(`
        SELECT address, utxo_value_sats AS balance, utxo_count,
               COALESCE(exposure_kind, CASE WHEN is_p2pk THEN 'p2pk' ELSE 'pkh' END) AS exposure_kind
        FROM address_info WHERE pubkey_exposed = TRUE AND utxo_count > 0
        ORDER BY utxo_value_sats DESC LIMIT 20
      `);

      // By exposure year — address_info has pubkey_exposed_at_block and pre-aggregated balance.
      // Only spend-revealed keys have an exposure block (P2PK / P2TR / P2MS are
      // exposed from creation), split into key-hash (016) and script (021).
      const { rows: yearRows } = await pool.query(`
        SELECT CASE WHEN exposure_kind IN ('script', 'script-mixed') THEN 'script' ELSE 'pkh' END AS class,
               EXTRACT(YEAR FROM pubkey_exposed_at_block::float8 / 100000 * interval '1 year' + timestamp '2009-01-03') yr,
               COUNT(*) addr_count,
               SUM(utxo_value_sats) total_sats
        FROM address_info
        WHERE pubkey_exposed_at_block IS NOT NULL AND utxo_count > 0
        GROUP BY 1, 2 ORDER BY 2
      `);
      const byYear = (cls: string) =>
        yearRows.filter(r => r.class === cls).map(({ class: _c, ...r }) => r);

      return {
        computed_at_block: snaps['quantum_all_exposed']?.computed_at_block ?? null,
        // Exposed from creation: the key is in the output script.
        p2pk: cat('quantum_p2pk'),
        p2tr: cat('quantum_p2tr'),
        p2ms: cat('quantum_p2ms'),
        // Exposed from first spend: the key (016) or script (021) was revealed.
        exposed_pkh: { ...cat('quantum_exposed_pkh'), by_exposure_year: byYear('pkh') },
        exposed_script: { ...cat('quantum_exposed_script'), by_exposure_year: byYear('script') },
        total: cat('quantum_all_exposed'),
        // Kept for callers of the previous shape.
        combined_total_sats: cat('quantum_all_exposed').total_sats,
        addresses_by_kind: byKind,
        top_addresses: top.map(r => ({
          address: r.address,
          balance: r.balance.toString(),
          utxo_count: r.utxo_count.toString(),
          exposure_kind: r.exposure_kind,
        })),
      };
    });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/quantum-curve
router.get('/quantum-curve', async (req: Request, res: Response) => {
  try {
    const data = await withCache('api:quantum-curve', 600, async () => {
      // Precomputed hourly by the ETL snapshot job (the window-function scan
      // over all exposed outputs is far too slow for request time). Response
      // keeps the original shape; more breakpoints than before.
      const stats = await getComputedStats(['quantum_curve']);
      const bps: any[] = stats['quantum_curve']?.data?.breakpoints ?? [];
      return {
        breakpoints: bps.map(bp => ({
          threshold_sats: bp.cum_sats,
          utxo_count: bp.utxo_count,
          total_sats: bp.cum_sats,
          address_count: bp.key_count,
          min_value_sats: bp.min_value_sats,
        })),
      };
    });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/concentration
router.get('/concentration', async (req: Request, res: Response) => {
  try {
    const minSats = req.query['min_sats'] ? BigInt(req.query['min_sats'] as string) : 100_000_000_000n;
    const cacheKey = `api:concentration:${minSats}`;

    const data = await withCache(cacheKey, 300, async () => {
      const { rows } = await pool.query(`
        SELECT address, utxo_value_sats AS balance, utxo_count,
               first_seen_block, last_active_block
        FROM address_info
        WHERE utxo_value_sats >= $1 AND utxo_count > 0
        ORDER BY utxo_value_sats DESC LIMIT 100
      `, [minSats]);

      return rows.map(r => ({
        address: r.address,
        balance: r.balance.toString(),
        utxo_count: r.utxo_count.toString(),
        first_seen_block: r.first_seen_block,
        last_active_block: r.last_active_block,
      }));
    });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/block/:n — JSON sibling of the /block/:n page.
router.get('/block/:n', async (req: Request, res: Response) => {
  try {
    const blockNum = parseInt(req.params['n']);
    if (isNaN(blockNum) || blockNum < 0) {
      return res.status(400).json({ error: 'Invalid block number' });
    }

    const data = await loadBlock(blockNum);
    if (!data) return res.status(404).json({ error: `Block ${blockNum} is not indexed` });
    const { block, lossOutputs: lossUtxos, lossCount } = data;

    // Same supply arithmetic the page renders: subsidy is derived from height,
    // fees are whatever the block was allowed to issue above the subsidy, and
    // miner_loss is subsidy+fees the coinbase never claimed.
    const subsidy = subsidyAt(blockNum);
    const allowed = BigInt(block.allowed_supply_sats ?? 0);
    const fees = allowed > subsidy ? allowed - subsidy : 0n;
    const minerLoss = BigInt(block.miner_loss_sats ?? 0);
    const txLoss = BigInt(data.lossSats);

    res.set('Cache-Control', ENTITY_CACHE_CONTROL);
    res.json({
      block_number: Number(block.block_number),
      block_hash: block.block_hash,
      block_timestamp: new Date(block.block_timestamp).toISOString(),
      tx_count: block.tx_count,
      supply: {
        subsidy: money(subsidy),
        fees: money(fees),
        coinbase_claimed: money(block.coinbase_value_sats ?? 0),
        // Coin the miner was entitled to but never claimed.
        miner_loss: money(minerLoss),
        // Coin removed by transactions sending to unspendable/lost outputs.
        tx_loss: money(txLoss),
        // Total removed from effective supply in this block.
        removed_total: money(minerLoss + txLoss),
      },
      lost_outputs: lossUtxos.map((u: any) => ({
        tx_hash: u.tx_hash,
        output_index: u.output_index,
        value: money(u.value_sats),
        loss_bucket: u.loss_bucket,
        loss_status: bucketLabel(u.loss_bucket),
        loss_rules: describeRules(u.loss_rules),
      })),
      lost_outputs_shown: lossUtxos.length,
      lost_outputs_truncated: lossCount > lossUtxos.length,
      html_url: canonical(`/block/${blockNum}`),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/address/:addr — JSON sibling of the /address/:addr page.
router.get('/address/:addr', async (req: Request, res: Response) => {
  try {
    const addr = req.params['addr'];
    if (!addr || addr.length > 128) {
      return res.status(400).json({ error: 'Invalid address' });
    }

    // Same two queries the page runs: the pre-aggregated row for exact totals,
    // and the 100 largest UTXOs.
    const { rows: addrRows } = await pool.query('SELECT * FROM address_info WHERE address = $1', [addr]);
    const addrInfo = addrRows[0] || null;

    const { rows: utxos } = await pool.query(`
      SELECT tx_hash, output_index, value_sats, block_number, block_timestamp,
             loss_rules, loss_bucket, pubkey_exposed, script_type
      FROM utxos WHERE address = $1
      ORDER BY value_sats DESC LIMIT 100
    `, [addr]);

    // address_info holds exact pre-aggregated totals; the LIMIT-100 sum would
    // understate an address holding more UTXOs than the page shows.
    const totalBalance = addrInfo
      ? BigInt(addrInfo.utxo_value_sats ?? 0)
      : utxos.reduce((sum: bigint, u: any) => sum + BigInt(u.value_sats), 0n);
    const totalUtxos = addrInfo ? Number(addrInfo.utxo_count) : utxos.length;
    const q = await addressQuantumStatus(addr, addrInfo);

    res.set('Cache-Control', ENTITY_CACHE_CONTROL);
    res.json({
      address: addr,
      // Whether we hold a pre-aggregated record. false means the totals below
      // are summed only from the visible UTXOs.
      indexed: addrInfo != null,
      balance: money(totalBalance),
      utxo_count: totalUtxos,
      // Block heights are small integers — expose them as numbers (pg returns
      // BIGINT columns as strings). Only sats stay strings, for precision.
      first_seen_block: addrInfo?.first_seen_block != null ? Number(addrInfo.first_seen_block) : null,
      last_active_block: addrInfo?.last_active_block != null ? Number(addrInfo.last_active_block) : null,
      quantum: {
        // A revealed public key makes the whole balance breakable by a
        // sufficiently powerful quantum computer.
        pubkey_exposed: q.exposed,
        is_p2pk: addrInfo?.is_p2pk ?? false,
        // How the key(s) became public: p2pk, p2tr, p2ms (in the output
        // script), pkh (revealed by a spend), script / script-mixed (revealed
        // redeem or witness script; "mixed" also has a hash-preimage branch),
        // reuse (the same key revealed at another of its addresses, 022).
        exposure_kind: q.kind,
        // Comma-joined when a script revealed several keys.
        pubkey_hex: q.keys.length ? q.keys.join(',') : null,
        exposed_at_block: q.block,
        // reuse: the sibling address whose spend revealed the key, if any.
        revealed_via: q.via,
        // false when found by the live lookup but not yet marked by the ETL.
        recorded: q.recorded,
        // For an address with no known key: whether the check covered keys
        // seen in scripts and other encodings too (see /address page).
        full_coverage: q.fullCoverage,
        as_of_block: q.asOfBlock,
      },
      utxos: utxos.map((u: any) => ({
        tx_hash: u.tx_hash,
        output_index: u.output_index,
        value: money(u.value_sats),
        block_number: Number(u.block_number),
        block_timestamp: new Date(u.block_timestamp).toISOString(),
        script_type: u.script_type,
        loss_bucket: u.loss_bucket,
        loss_status: bucketLabel(u.loss_bucket),
        loss_rules: describeRules(u.loss_rules),
        pubkey_exposed: u.pubkey_exposed,
      })),
      // The UTXO list is capped at the 100 largest; totals above are exact.
      utxos_shown: utxos.length,
      utxos_truncated: totalUtxos > utxos.length,
      html_url: canonical(`/address/${addr}`),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/transaction/:hash — JSON sibling of the /transaction/:hash page.
// Folds live Bitcoin Core RPC (the raw tx) together with our per-output loss
// classification. Note: our utxos table holds only UNSPENT outputs, so an
// output that has since been spent carries no classification here — `unspent`
// flags which outputs we can still speak to.
router.get('/transaction/:hash', async (req: Request, res: Response) => {
  try {
    const txHash = req.params['hash'];
    if (!/^[0-9a-fA-F]{64}$/.test(txHash ?? '')) {
      return res.status(400).json({ error: 'Invalid transaction id' });
    }

    let tx: any;
    try {
      tx = await getCachedRawTransaction(txHash);
    } catch {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const { rows: utxoRows } = await pool.query(`
      SELECT output_index, value_sats, loss_rules, loss_bucket, address, script_type
      FROM utxos WHERE tx_hash = $1
    `, [txHash]);
    const utxoMap: Record<number, any> = {};
    for (const row of utxoRows) utxoMap[row.output_index] = row;

    const vout = tx.vout ?? [];
    // RPC gives output value as a BTC float; take it through sats exactly, the
    // same conversion the page uses.
    const toSats = (v: number) => BigInt(Math.round((v ?? 0) * 1e8));
    const outputTotal = vout.reduce((s: bigint, v: any) => s + toSats(v.value), 0n);
    const lostRows = utxoRows.filter((r: any) => r.loss_bucket === 1 || r.loss_bucket === 2);
    const lostTotal = lostRows.reduce((s: bigint, r: any) => s + BigInt(r.value_sats), 0n);

    res.set('Cache-Control', ENTITY_CACHE_CONTROL);
    res.json({
      txid: tx.txid,
      confirmations: tx.confirmations ?? null,
      size_bytes: tx.size ?? null,
      is_coinbase: tx.vin?.[0]?.coinbase !== undefined,
      input_count: (tx.vin ?? []).length,
      output_count: vout.length,
      output_total: money(outputTotal),
      // The site's value-add in aggregate: how much of this tx is lost coin.
      lost: {
        output_count: lostRows.length,
        value: money(lostTotal),
      },
      outputs: vout.map((v: any) => {
        const c = utxoMap[v.n];
        return {
          n: v.n,
          value: money(toSats(v.value)),
          address: v.scriptPubKey?.address ?? null,
          script_type: v.scriptPubKey?.type ?? null,
          // Whether this output is still in our UTXO set (and thus classified).
          unspent: c != null,
          loss_bucket: c ? c.loss_bucket : null,
          loss_status: c ? bucketLabel(c.loss_bucket) : null,
          loss_rules: c ? describeRules(c.loss_rules) : [],
        };
      }),
      html_url: canonical(`/transaction/${txHash}`),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/events (SSE)
router.get('/events', async (req: Request, res: Response) => {
  await addSSEClient(res);
});

export default router;
