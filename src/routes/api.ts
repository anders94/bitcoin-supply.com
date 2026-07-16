import { Router, Request, Response } from 'express';
import { pool } from '../db/index.js';
import { getComputedStats } from '../db/computed-stats.js';
import { withCache } from '../services/redis.js';
import { addSSEClient } from '../services/sse.js';
import { config } from '../config.js';

const router = Router();

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
         WHERE snapshot_key IN ('provably_lost', 'probably_lost', 'quantum_p2pk', 'quantum_all_exposed', 'all_utxos')`
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
      // P2PK stats
      const { rows: p2pkRows } = await pool.query(`
        SELECT COALESCE(SUM(value_sats), 0) total_sats, COUNT(*) utxo_count
        FROM utxos WHERE loss_rules @> '{015}'
      `);

      // Top P2PK addresses — use pre-aggregated address_info with is_p2pk flag
      const { rows: topP2pk } = await pool.query(`
        SELECT address, utxo_value_sats AS balance, utxo_count
        FROM address_info WHERE is_p2pk = TRUE AND utxo_count > 0
        ORDER BY utxo_value_sats DESC LIMIT 20
      `);

      // Exposed PKH stats (pubkey revealed via prior spend, not P2PK)
      const { rows: exposedRows } = await pool.query(`
        SELECT COALESCE(SUM(utxo_value_sats), 0) total_sats, SUM(utxo_count) utxo_count
        FROM address_info WHERE pubkey_exposed = TRUE AND is_p2pk = FALSE AND utxo_count > 0
      `);

      // By exposure year — address_info has pubkey_exposed_at_block and pre-aggregated balance
      const { rows: byYear } = await pool.query(`
        SELECT EXTRACT(YEAR FROM pubkey_exposed_at_block::float8 / 100000 * interval '1 year' + timestamp '2009-01-03') yr,
               COUNT(*) addr_count,
               SUM(utxo_value_sats) total_sats
        FROM address_info
        WHERE pubkey_exposed_at_block IS NOT NULL AND utxo_count > 0
        GROUP BY 1 ORDER BY 1
      `);

      const p2pkTotal = BigInt(p2pkRows[0].total_sats);
      const exposedTotal = BigInt(exposedRows[0].total_sats);

      return {
        p2pk: {
          total_sats: p2pkTotal.toString(),
          utxo_count: p2pkRows[0].utxo_count.toString(),
          top_addresses: topP2pk.map(r => ({
            address: r.address,
            balance: r.balance.toString(),
            utxo_count: r.utxo_count.toString(),
          })),
        },
        exposed_pkh: {
          total_sats: exposedTotal.toString(),
          utxo_count: exposedRows[0].utxo_count.toString(),
          by_exposure_year: byYear,
        },
        combined_total_sats: (p2pkTotal + exposedTotal).toString(),
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
      // Single CTE computes the window function once and aggregates all thresholds in one pass.
      // Previously this ran 7 separate queries each doing a full window-function scan.
      const { rows } = await pool.query(`
        WITH ranked AS (
          SELECT address, value_sats,
                 SUM(value_sats) OVER (ORDER BY value_sats DESC) AS cumulative
          FROM utxos WHERE pubkey_exposed = TRUE
        )
        SELECT
          COUNT(*) FILTER (WHERE cumulative <= 1000000000)                      AS utxo_count_t0,
          SUM(value_sats) FILTER (WHERE cumulative <= 1000000000)               AS total_sats_t0,
          COUNT(DISTINCT address) FILTER (WHERE cumulative <= 1000000000)       AS addr_count_t0,
          MIN(value_sats) FILTER (WHERE cumulative <= 1000000000)               AS min_sats_t0,
          COUNT(*) FILTER (WHERE cumulative <= 10000000000)                     AS utxo_count_t1,
          SUM(value_sats) FILTER (WHERE cumulative <= 10000000000)              AS total_sats_t1,
          COUNT(DISTINCT address) FILTER (WHERE cumulative <= 10000000000)      AS addr_count_t1,
          MIN(value_sats) FILTER (WHERE cumulative <= 10000000000)              AS min_sats_t1,
          COUNT(*) FILTER (WHERE cumulative <= 100000000000)                    AS utxo_count_t2,
          SUM(value_sats) FILTER (WHERE cumulative <= 100000000000)             AS total_sats_t2,
          COUNT(DISTINCT address) FILTER (WHERE cumulative <= 100000000000)     AS addr_count_t2,
          MIN(value_sats) FILTER (WHERE cumulative <= 100000000000)             AS min_sats_t2,
          COUNT(*) FILTER (WHERE cumulative <= 1000000000000)                   AS utxo_count_t3,
          SUM(value_sats) FILTER (WHERE cumulative <= 1000000000000)            AS total_sats_t3,
          COUNT(DISTINCT address) FILTER (WHERE cumulative <= 1000000000000)    AS addr_count_t3,
          MIN(value_sats) FILTER (WHERE cumulative <= 1000000000000)            AS min_sats_t3,
          COUNT(*) FILTER (WHERE cumulative <= 10000000000000)                  AS utxo_count_t4,
          SUM(value_sats) FILTER (WHERE cumulative <= 10000000000000)           AS total_sats_t4,
          COUNT(DISTINCT address) FILTER (WHERE cumulative <= 10000000000000)   AS addr_count_t4,
          MIN(value_sats) FILTER (WHERE cumulative <= 10000000000000)           AS min_sats_t4,
          COUNT(*) FILTER (WHERE cumulative <= 100000000000000)                 AS utxo_count_t5,
          SUM(value_sats) FILTER (WHERE cumulative <= 100000000000000)          AS total_sats_t5,
          COUNT(DISTINCT address) FILTER (WHERE cumulative <= 100000000000000)  AS addr_count_t5,
          MIN(value_sats) FILTER (WHERE cumulative <= 100000000000000)          AS min_sats_t5,
          COUNT(*)                                                               AS utxo_count_max,
          COALESCE(SUM(value_sats), 0)                                          AS total_sats_max,
          COUNT(DISTINCT address)                                                AS addr_count_max,
          MIN(value_sats)                                                        AS min_sats_max
        FROM ranked
      `);

      const r = rows[0];
      const thresholdDefs = [
        { suffix: 't0', threshold: '1000000000' },
        { suffix: 't1', threshold: '10000000000' },
        { suffix: 't2', threshold: '100000000000' },
        { suffix: 't3', threshold: '1000000000000' },
        { suffix: 't4', threshold: '10000000000000' },
        { suffix: 't5', threshold: '100000000000000' },
      ];

      const breakpoints = thresholdDefs
        .filter(({ suffix }) => parseInt(r[`utxo_count_${suffix}`]) > 0)
        .map(({ suffix, threshold }) => ({
          threshold_sats: threshold,
          utxo_count: r[`utxo_count_${suffix}`].toString(),
          total_sats: (r[`total_sats_${suffix}`] ?? '0').toString(),
          address_count: r[`addr_count_${suffix}`].toString(),
          min_value_sats: (r[`min_sats_${suffix}`] ?? '0').toString(),
        }));

      breakpoints.push({
        threshold_sats: (r.total_sats_max ?? '0').toString(),
        utxo_count: r.utxo_count_max.toString(),
        total_sats: (r.total_sats_max ?? '0').toString(),
        address_count: r.addr_count_max.toString(),
        min_value_sats: (r.min_sats_max ?? '0').toString(),
      });

      return { breakpoints };
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

// GET /api/v1/events (SSE)
router.get('/events', (req: Request, res: Response) => {
  addSSEClient(res);
});

export default router;
