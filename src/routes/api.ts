import { Router, Request, Response } from 'express';
import { pool } from '../db/index.js';
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
        whereClause = `WHERE (loss_bucket BETWEEN 1 AND 2)
          OR (loss_bucket = 0 AND block_timestamp <= $1)`;
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
      const { rows } = await pool.query(`
        SELECT unnest(loss_rules) rule, SUM(value_sats) total_sats, COUNT(*) utxo_count
        FROM utxos WHERE loss_bucket > 0
        GROUP BY 1 ORDER BY total_sats DESC
      `);
      return rows.map(r => ({
        rule: r.rule,
        total_sats: r.total_sats.toString(),
        utxo_count: r.utxo_count.toString(),
      }));
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

      // Top P2PK addresses
      const { rows: topP2pk } = await pool.query(`
        SELECT address, SUM(value_sats) balance, COUNT(*) utxo_count
        FROM utxos WHERE loss_rules @> '{015}' AND address IS NOT NULL
        GROUP BY address ORDER BY balance DESC LIMIT 20
      `);

      // Exposed PKH stats (pubkey revealed via prior spend, not P2PK)
      const { rows: exposedRows } = await pool.query(`
        SELECT COALESCE(SUM(value_sats), 0) total_sats, COUNT(*) utxo_count
        FROM utxos WHERE pubkey_exposed = TRUE AND NOT (loss_rules @> '{015}')
      `);

      // By exposure year
      const { rows: byYear } = await pool.query(`
        SELECT EXTRACT(YEAR FROM ai.pubkey_exposed_at_block::text::bigint::float8 / 100000 * interval '1 year' + timestamp '2009-01-03') yr,
               COUNT(DISTINCT u.address) addr_count,
               SUM(u.value_sats) total_sats
        FROM utxos u
        JOIN address_info ai ON ai.address = u.address
        WHERE u.pubkey_exposed = TRUE AND ai.pubkey_exposed_at_block IS NOT NULL
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
      // Cumulative curve sorted by value descending
      // Breakpoints at cumulative thresholds
      const thresholds = [
        1_000_000_000n,       // 10 BTC
        10_000_000_000n,      // 100 BTC
        100_000_000_000n,     // 1,000 BTC
        1_000_000_000_000n,   // 10,000 BTC
        10_000_000_000_000n,  // 100,000 BTC
        100_000_000_000_000n, // 1,000,000 BTC
      ];

      const breakpoints = [];
      for (const threshold of thresholds) {
        const { rows } = await pool.query(`
          SELECT COUNT(*) utxo_count, SUM(value_sats) total_sats,
                 COUNT(DISTINCT address) address_count,
                 MIN(value_sats) min_value_sats
          FROM (
            SELECT address, value_sats, SUM(value_sats) OVER (ORDER BY value_sats DESC) cumulative
            FROM utxos WHERE pubkey_exposed = TRUE
          ) sub
          WHERE cumulative <= $1
        `, [threshold]);

        if (rows[0].utxo_count > 0) {
          breakpoints.push({
            threshold_sats: threshold.toString(),
            utxo_count: rows[0].utxo_count.toString(),
            total_sats: rows[0].total_sats?.toString() ?? '0',
            address_count: rows[0].address_count.toString(),
            min_value_sats: rows[0].min_value_sats?.toString() ?? '0',
          });
        }
      }

      // Add max (all exposed)
      const { rows: maxRows } = await pool.query(`
        SELECT COUNT(*) utxo_count, COALESCE(SUM(value_sats), 0) total_sats,
               COUNT(DISTINCT address) address_count, MIN(value_sats) min_value_sats
        FROM utxos WHERE pubkey_exposed = TRUE
      `);
      breakpoints.push({
        threshold_sats: maxRows[0].total_sats?.toString() ?? '0',
        utxo_count: maxRows[0].utxo_count.toString(),
        total_sats: maxRows[0].total_sats?.toString() ?? '0',
        address_count: maxRows[0].address_count.toString(),
        min_value_sats: maxRows[0].min_value_sats?.toString() ?? '0',
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
        SELECT address, SUM(value_sats) balance, COUNT(*) utxo_count,
               MIN(block_timestamp) first_seen, MAX(block_timestamp) last_active
        FROM utxos WHERE address IS NOT NULL
        GROUP BY address HAVING SUM(value_sats) >= $1
        ORDER BY balance DESC LIMIT 100
      `, [minSats]);

      return rows.map(r => ({
        address: r.address,
        balance: r.balance.toString(),
        utxo_count: r.utxo_count.toString(),
        first_seen: r.first_seen,
        last_active: r.last_active,
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
