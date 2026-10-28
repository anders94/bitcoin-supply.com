import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { marked } from 'marked';
import { config } from '../config.js';
import { pool } from '../db/index.js';
import { getAllSnapshots } from '../db/snapshots.js';
import { getComputedStats } from '../db/computed-stats.js';
import { addressQuantumStatus } from '../db/address-info.js';
import { isValidAddress } from '../classifiers/exposure.js';
import { getCachedRawTransaction } from '../services/tx-data.js';
import { getTip } from '../services/tip.js';
import { loadBlock } from '../services/block-data.js';
import { pageCache } from '../middleware/page-cache.js';
import {
  btcParts, btc8, btc2, num,
  shortHash, shortAddress, dateUtc, dateTimeUtc, subsidyAt,
} from '../helpers/format.js';
import {
  RULE_CHIP_LABELS, BREAKDOWN_GROUPS, ruleCategory, CATEGORY_CHIP_CLASS, safeJson,
  EXPOSURE_KIND_CHIP, EXPOSURE_KIND_TEXT, RULE_TITLES,
} from '../helpers/breakdown.js';

const router = Router();

const CAP_SATS = 2_100_000_000_000_000n;
const DORMANCY_YEARS = [1, 3, 5, 7, 10, 15, 20];

// Helpers available to every view. BTC figures use btc8 — btc2 is deliberately
// not exposed here, so a view can't round a satoshi-sized value away to 0.00.
const viewHelpers = {
  btcParts, btc8, num,
  shortHash, shortAddress, dateUtc, dateTimeUtc,
  ruleChip: (rule: string) => `${rule} ${RULE_CHIP_LABELS[rule] ?? ''}`.trim(),
  ruleCategory,
};

const OG_DEFAULT_DESCRIPTION =
  'Tracking Bitcoin’s effective supply: how much of the 21M cap is provably lost, ' +
  'probably lost, dormant, or exposed to a quantum attacker — measured UTXO by UTXO ' +
  'from full-chain analysis.';

// Serve the canonical pages from Redis where possible. Registered first, on
// purpose: a hit returns before the meta/tip middlewares below, so it costs no
// database work at all.
router.use(pageCache());

// Social-preview metadata. Routes overwrite `description` (and occasionally
// `ogTitle`) on res.locals.meta; the layout renders the tags.
router.use((req: Request, res: Response, next) => {
  res.locals.meta = {
    type: 'website',
    url: config.server.publicUrl + req.originalUrl,
    image: config.server.publicUrl + '/images/og-card.png',
    imageAlt: 'bitcoin-supply — the effective Bitcoin supply explorer',
    description: OG_DEFAULT_DESCRIPTION,
  };
  next();
});

// Every page's header shows the live tip; seed it via SSR on each request.
router.use(async (req: Request, res: Response, next) => {
  res.locals.tip = { ...await getTip(), lag: config.etl.confirmationLag };
  next();
});

function renderError(res: Response, code: number, message: string) {
  return res.status(code).render('error', { title: 'Error', message, code, ...viewHelpers });
}

// Edge cache headers for the deep routes (/block/:n, /transaction/:hash,
// /address/:addr). These deliberately do NOT go through middleware/page-cache.ts
// — read the whitelist warning there: Redis runs noeviction, so an unbounded
// keyspace would break writes. Cloudflare's cache has no such failure mode, so
// the deep routes get an edge TTL and no Redis key.
//
// s-maxage carries the real TTL because only the shared cache should hold these
// for minutes; max-age stays short so a browser doesn't pin a stale balance in
// history. Set on 200s only — renderError paths stay uncached, or a 404 for an
// address funded next week would outlive the funding.
//
// Note this buys little against a scraper walking distinct URLs (hit rate ~0);
// it is here for repeat crawls and real readers, not as a load shield.
function cacheFor(res: Response, sMaxAge: number): void {
  res.set('Cache-Control',
    `public, max-age=60, s-maxage=${sMaxAge}, stale-while-revalidate=3600`);
}

// Linear interpolation over an ascending table of [x, y] pairs (shared shape
// with the client-side port in public/javascripts/lib/interp.ts).
function interp(tbl: [number, number][], x: number): number {
  if (!tbl.length) return 0;
  if (x <= tbl[0][0]) return tbl[0][1];
  if (x >= tbl[tbl.length - 1][0]) return tbl[tbl.length - 1][1];
  let i = 1;
  while (i < tbl.length - 1 && tbl[i][0] < x) i++;
  const [x0, y0] = tbl[i - 1];
  const [x1, y1] = tbl[i];
  if (x1 === x0) return y1;
  return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
}

// GET / - Homepage
router.get('/', async (req: Request, res: Response) => {
  try {
    const snapshots = await getAllSnapshots();
    const stats = await getComputedStats(['rule_breakdown', 'quantum_curve', 'top_losses', 'halvings']);

    const { rows: recentLosses } = await pool.query(`
      SELECT tx_hash, output_index, value_sats, block_number, loss_rules
      FROM utxos WHERE loss_bucket = 1
      ORDER BY block_number DESC, value_sats DESC
      LIMIT 4
    `);

    const snap = (key: string) => ({
      sats: (snapshots[key]?.total_sats ?? 0n).toString(),
      count: (snapshots[key]?.utxo_count ?? 0n).toString(),
    });

    const all = snap('all_utxos');
    const provable = snap('provably_lost');
    const probable = snap('probably_lost');
    const p2pk = snap('quantum_p2pk');
    const p2tr = snap('quantum_p2tr');
    const p2ms = snap('quantum_p2ms');
    const exposedScript = snap('quantum_exposed_script');
    const exposed = snap('quantum_all_exposed');
    // Until the first snapshot after the 019/020/021 deploy, the split keys are
    // absent and everything that isn't P2PK is a revealed P2PKH/P2WPKH key.
    const exposedPkh = snapshots['quantum_exposed_pkh']
      ? snap('quantum_exposed_pkh')
      : { sats: (BigInt(exposed.sats) - BigInt(p2pk.sats)).toString(), count: '0' };

    const breakdownRules: any[] = stats['rule_breakdown']?.data?.rules ?? [];
    const ruleTotal = (rules: string[], field: 'total_sats' | 'utxo_count') =>
      rules.reduce((sum, r) => sum + BigInt(breakdownRules.find(b => b.rule === r)?.[field] ?? 0), 0n);

    const breakdown = {
      provable: BREAKDOWN_GROUPS.provable.map(g => ({
        rules: g.rules, label: g.label,
        sats: ruleTotal(g.rules, 'total_sats').toString(),
        count: ruleTotal(g.rules, 'utxo_count').toString(),
      })),
      probable: BREAKDOWN_GROUPS.probable.map(g => ({
        rules: g.rules, label: g.label,
        sats: ruleTotal(g.rules, 'total_sats').toString(),
        count: ruleTotal(g.rules, 'utxo_count').toString(),
      })),
    };

    const curve: any[] = stats['quantum_curve']?.data?.breakpoints ?? [];
    const totalKeys = curve.length ? curve[curve.length - 1].key_count : '0';

    const supply = {
      tip: res.locals.tip,
      cap_sats: CAP_SATS.toString(),
      all_sats: all.sats, all_count: all.count,
      provable_sats: provable.sats, provable_count: provable.count,
      probable_sats: probable.sats, probable_count: probable.count,
      miner_never_claimed_sats: stats['rule_breakdown']?.data?.miner_loss?.total_sats ?? '0',
      dormancy: DORMANCY_YEARS.map(years => {
        const s = snap(`dormant_${years}y`);
        return { years, sats: s.sats, count: s.count };
      }),
      breakdown,
      quantum: {
        p2pk_sats: p2pk.sats,
        p2tr_sats: p2tr.sats,
        p2ms_sats: p2ms.sats,
        exposed_pkh_sats: exposedPkh.sats,
        exposed_script_sats: exposedScript.sats,
        total_sats: exposed.sats,
        total_keys: totalKeys,
        curve: curve.map(bp => ({
          cum_sats: bp.cum_sats, key_count: bp.key_count, min_value_sats: bp.min_value_sats,
        })),
      },
      computed_at: snapshots['all_utxos']
        ? new Date((snapshots['all_utxos'] as any).computed_at ?? Date.now()).toISOString()
        : new Date(0).toISOString(),
    };

    // SSR the default state (stop = PROVABLE, dormancy 10y, quantum 30%) so
    // the page reads correctly before (or without) JavaScript.
    const allN = Number(all.sats);
    const oocN = Number(provable.sats);
    const effSats = BigInt(all.sats) - BigInt(provable.sats);
    const dorm10 = supply.dormancy.find(d => d.years === 10)!;

    const qTotalN = Number(exposed.sats);
    const capN = qTotalN * 0.3;
    const keyTbl: [number, number][] = [[0, 0], ...curve.map(bp => [Number(bp.cum_sats), Number(bp.key_count)] as [number, number])];
    const minTbl: [number, number][] = curve.map(bp => [Number(bp.cum_sats), Number(bp.min_value_sats)] as [number, number]);
    const minwN = minTbl.length ? interp(minTbl, capN) : 0;

    const ssr = {
      eff: btcParts(effSats),
      oocBtc: btc8(provable.sats),
      // The headline figures render the fraction in its own span so it can be
      // set smaller and lighter — at full 8-decimal precision they otherwise
      // crowd the hero's last column.
      oocParts: btcParts(provable.sats),
      oocPct: allN > 0 ? (oocN / allN * 100).toFixed(3) + '%' : '0%',
      effW: (Number(effSats) / Number(CAP_SATS) * 100).toFixed(3),
      oocW: oocN > 0 ? Math.max(0.45, oocN / Number(CAP_SATS) * 100).toFixed(3) : '0',
      qW: Number(effSats) > 0 ? (capN / Number(effSats) * 100).toFixed(2) : '0',
      dormantValue: btc8(dorm10.sats),
      activeValue: btc8((BigInt(all.sats) - BigInt(probable.sats) - BigInt(dorm10.sats)).toString()),
      q: {
        pct: qTotalN > 0 ? (capN / qTotalN * 100).toFixed(1) + '%' : '0%',
        // The attack sweep interpolates over the curve, so these land between
        // whole sats; round to a sat and show the full 8 decimals like every
        // other BTC figure on the site.
        captured: btc8(BigInt(Math.round(capN))),
        // Hero figure: everything exposed, independent of the slider.
        exposedParts: btcParts(exposed.sats),
        keys: Math.round(interp(keyTbl, capN)).toLocaleString('en-US'),
        minWorth: btc8(BigInt(Math.round(minwN))) + ' BTC',
        effAfter: btc8(BigInt(Math.round(Math.max(Number(effSats) - capN, 0)))),
      },
    };

    res.locals.meta.ogTitle = 'bitcoin-supply — the effective Bitcoin supply explorer';
    res.locals.meta.description =
      `Bitcoin’s effective supply is ${btc2(effSats)} BTC as of block ` +
      `${num(res.locals.tip.height)}: ${btc2(provable.sats)} BTC is provably lost, ` +
      `another ${btc2(BigInt(probable.sats) - BigInt(provable.sats))} BTC probably lost, ` +
      `and ${btc2(exposed.sats)} BTC is exposed to a quantum attacker. ` +
      'Explore losses, dormancy and quantum exposure block by block.';

    res.render('index', {
      title: 'bitcoin-supply — effective supply explorer',
      supplyJson: safeJson(supply),
      supply,
      ssr,
      recentLosses,
      topLosses: stats['top_losses']?.data?.entries ?? [],
      halvings: stats['halvings']?.data?.events ?? [],
      freshness: supply.computed_at,
      ...viewHelpers,
    });
  } catch (err) {
    console.error(err);
    renderError(res, 500, 'Failed to load homepage');
  }
});

// GET /block/:n - Block loss explorer
router.get('/block/:n', async (req: Request, res: Response) => {
  try {
    const blockNum = parseInt(req.params['n']);
    if (isNaN(blockNum) || blockNum < 0) return renderError(res, 400, 'Invalid block number');

    const data = await loadBlock(blockNum);
    if (!data) return renderError(res, 404, `Block ${num(blockNum)} is not indexed`);
    const { block, lossOutputs: lossUtxos, pager } = data;
    const prevLoss = pager.prev;
    const nextLoss = pager.next;

    const subsidy = subsidyAt(blockNum);
    const allowed = BigInt(block.allowed_supply_sats ?? 0);
    const fees = allowed > subsidy ? allowed - subsidy : 0n;
    const minerLoss = BigInt(block.miner_loss_sats ?? 0);
    const txLoss = BigInt(data.lossSats);

    const removed = minerLoss + txLoss;
    res.locals.meta.description = removed > 0n
      ? `Block ${num(blockNum)} (${dateUtc(block.block_timestamp)}) removed ` +
        `${btc8(removed)} BTC from Bitcoin’s effective supply` +
        (minerLoss > 0n ? ` — including ${btc8(minerLoss)} BTC the miner never claimed` : '') +
        '. See every lost output in this block.'
      : `Block ${num(blockNum)} (${dateUtc(block.block_timestamp)}): ` +
        `${btc8(subsidy)} BTC subsidy, ${btc8(fees)} BTC in fees, no coins lost. ` +
        'Supply accounting on bitcoin-supply.';

    // A deep block is frozen, but one near the indexed frontier is not: pager.next
    // is the *next* loss block, so it keeps changing as the ETL indexes further.
    // 100 blocks is ~16h — well past any pager churn or reorg of the 6-block lag.
    const tipHeight = Number(res.locals.tip?.height ?? 0);
    cacheFor(res, tipHeight - blockNum > 100 ? 86_400 : 300);

    res.render('block', {
      title: `Block ${num(blockNum)}`,
      block,
      blockNum,
      lossUtxos,
      subsidy: subsidy.toString(),
      fees: fees.toString(),
      claimed: (block.coinbase_value_sats ?? 0).toString(),
      minerLoss: minerLoss.toString(),
      txLoss: txLoss.toString(),
      removedTotal: removed.toString(),
      pager: {
        prev: prevLoss,
        prevSkipped: prevLoss != null ? blockNum - prevLoss - 1 : null,
        next: nextLoss,
        nextSkipped: nextLoss != null ? nextLoss - blockNum - 1 : null,
      },
      ...viewHelpers,
    });
  } catch (err) {
    console.error(err);
    renderError(res, 500, 'Failed to load block');
  }
});

// GET /losses - Filterable loss event history
router.get('/losses', async (req: Request, res: Response) => {
  try {
    // Cap the OFFSET depth: the loss set is ~238M rows and unbounded offsets
    // walk the index linearly (page 2,000 ≈ 100k rows ≈ still fast).
    const MAX_PAGE = 2000;
    const page = Math.min(MAX_PAGE, Math.max(1, parseInt(req.query['page'] as string || '1') || 1));
    const perPage = 50;
    const offset = (page - 1) * perPage;
    const filterRule = (req.query['rule'] as string | undefined)?.match(/^\d{3}$/)
      ? (req.query['rule'] as string) : undefined;

    const snapshots = await getAllSnapshots();
    const stats = await getComputedStats(['rule_breakdown']);
    const breakdownRules: any[] = stats['rule_breakdown']?.data?.rules ?? [];
    const minerLossInfo = stats['rule_breakdown']?.data?.miner_loss ?? { total_sats: '0', block_count: '0' };

    const chips = [
      { id: 'ALL', count: (snapshots['probably_lost']?.utxo_count ?? 0n).toString() },
      ...breakdownRules
        .filter(r => r.utxo_count !== '0' && ruleCategory(r.rule) !== 'quantum')
        .map(r => ({ id: r.rule, count: r.utxo_count })),
    ];
    if (BigInt(minerLossInfo.block_count) > 0n) {
      const idx = chips.findIndex(c => c.id > '002');
      chips.splice(idx === -1 ? chips.length : idx, 0, { id: '002', count: minerLossInfo.block_count });
    }

    let rows: any[];
    let total: bigint;
    if (filterRule === '002') {
      const { rows: blockRows } = await pool.query(`
        SELECT block_number, block_timestamp, miner_loss_sats
        FROM blocks WHERE miner_loss_sats > 0
        ORDER BY block_number DESC LIMIT $1 OFFSET $2
      `, [perPage, offset]);
      rows = blockRows.map(b => ({
        is_block: true,
        block_number: b.block_number,
        block_timestamp: b.block_timestamp,
        value_sats: b.miner_loss_sats,
        rule: '002',
      }));
      total = BigInt(minerLossInfo.block_count);
    } else {
      const params: any[] = [perPage, offset];
      let where = 'WHERE loss_bucket IN (1, 2)';
      if (filterRule) {
        where += ' AND loss_rules @> $3';
        params.push(`{${filterRule}}`);
      }
      const { rows: lossRows } = await pool.query(`
        SELECT tx_hash, output_index, value_sats, block_number, block_timestamp, loss_rules
        FROM utxos ${where}
        ORDER BY block_number DESC, value_sats DESC
        LIMIT $1 OFFSET $2
      `, params);
      rows = lossRows;
      total = filterRule
        ? BigInt(breakdownRules.find(r => r.rule === filterRule)?.utxo_count ?? 0)
        : BigInt(snapshots['probably_lost']?.utxo_count ?? 0n);
    }

    const totalPages = Math.min(MAX_PAGE, Math.max(1, Math.ceil(Number(total) / perPage)));

    const lostSats = (snapshots['probably_lost']?.total_sats ?? 0n).toString();
    res.locals.meta.description =
      (filterRule
        ? `${num(total)} Bitcoin loss events under rule ${viewHelpers.ruleChip(filterRule)}`
        : `${num(total)} recorded Bitcoin loss events totaling ${btc2(lostSats)} BTC`) +
      ' — every provably or probably lost output on the blockchain, newest first.' +
      (page > 1 ? ` Page ${num(page)} of ${num(totalPages)}.` : '');

    res.render('losses', {
      title: 'Loss history',
      losses: rows,
      chips,
      page,
      totalPages,
      totalEvents: total.toString(),
      filterRule,
      ...viewHelpers,
    });
  } catch (err) {
    console.error(err);
    renderError(res, 500, 'Failed to load losses');
  }
});

// Compact magnitude label for matrix cells: 2.9M / 310k / 300.
function fmtMag(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  if (n >= 1) return String(Math.round(n));
  return n.toFixed(2);
}

// Pre-render both unit variants of the age x value matrix; the client toggle
// just swaps cells. Cell shade scales with value; text flips to paper when dark.
function matrixCells(grid: string[][], isBtc: boolean) {
  const vals = grid.map(row => row.map(s => (isBtc ? Number(BigInt(s)) / 1e8 : Number(s))));
  const max = Math.max(...vals.flat(), 1);
  return vals.map(row => row.map(v => {
    const a = 0.05 + 0.55 * v / max;
    return {
      v: fmtMag(v),
      bg: `rgba(27,26,22,${a.toFixed(2)})`,
      fg: a > 0.34 ? '#fbfaf7' : '#1b1a16',
    };
  }));
}

// GET /utxos - UTXO set observatory
router.get('/utxos', async (req: Request, res: Response) => {
  try {
    const snapshots = await getAllSnapshots();
    const stats = await getComputedStats(['age_value_matrix', 'dormant_giants']);

    const { rows: historyRows } = await pool.query(`
      SELECT DISTINCT ON (EXTRACT(YEAR FROM as_of_date))
             EXTRACT(YEAR FROM as_of_date)::int AS year, total_sats
      FROM snapshot_history WHERE snapshot_key = 'provably_lost'
      ORDER BY EXTRACT(YEAR FROM as_of_date), as_of_date DESC
    `);
    const bars = historyRows.slice(-15).map(r => ({ year: r.year, sats: r.total_sats.toString() }));
    const maxBar = bars.reduce((m, b) => (BigInt(b.sats) > m ? BigInt(b.sats) : m), 1n);

    const matrix = stats['age_value_matrix']?.data ?? { btc: [], count: [] };
    const cells = {
      btc: matrix.btc.length ? matrixCells(matrix.btc, true) : [],
      count: matrix.count.length ? matrixCells(matrix.count, false) : [],
    };

    const utxoCount = (snapshots['all_utxos']?.utxo_count ?? 0n).toString();
    res.locals.meta.description =
      `The Bitcoin UTXO set under a microscope: ${num(utxoCount)} unspent outputs ` +
      'mapped by age and value, the dormant giants that never move, and the ' +
      'year-by-year growth of provably lost coin.';

    res.render('utxos', {
      title: 'The UTXO set',
      utxoCount,
      cells,
      cellsJson: safeJson(cells),
      giants: stats['dormant_giants']?.data?.giants ?? [],
      bars: bars.map(b => ({
        ...b,
        heightPct: (Number(BigInt(b.sats) * 1000n / maxBar) / 10).toFixed(1),
      })),
      barRange: bars.length ? `${bars[0].year} → ${bars[bars.length - 1].year}` : '',
      ...viewHelpers,
    });
  } catch (err) {
    console.error(err);
    renderError(res, 500, 'Failed to load UTXO observatory');
  }
});

// GET /about
router.get('/about', (req: Request, res: Response) => {
  res.locals.meta.description =
    'How bitcoin-supply.com works: the methodology, data pipeline and ' +
    'classification rules behind its estimates of lost, dormant and ' +
    'quantum-vulnerable Bitcoin.';
  res.render('about', { title: 'About', ...viewHelpers });
});

// GET /transaction/:hash
router.get('/transaction/:hash', async (req: Request, res: Response) => {
  try {
    const txHash = req.params['hash'];
    let tx: any;
    try {
      tx = await getCachedRawTransaction(txHash);
    } catch {
      return renderError(res, 404, 'Transaction not found');
    }

    const { rows: utxoRows } = await pool.query(`
      SELECT output_index, value_sats, loss_rules, loss_bucket, address, script_type
      FROM utxos WHERE tx_hash = $1
    `, [txHash]);
    const utxoMap: Record<number, any> = {};
    for (const row of utxoRows) utxoMap[row.output_index] = row;

    const outTotal = (tx.vout ?? []).reduce((s: number, v: any) => s + (v.value ?? 0), 0);
    const lostOutputs = utxoRows.filter((r: any) => r.loss_bucket === 1 || r.loss_bucket === 2).length;
    res.locals.meta.description =
      `Bitcoin transaction ${shortHash(txHash)}: ${num((tx.vout ?? []).length)} outputs ` +
      `totaling ${outTotal.toLocaleString('en-US', { maximumFractionDigits: 8 })} BTC` +
      (lostOutputs > 0
        ? `, ${num(lostOutputs)} of them classified as lost coin.`
        : '.') +
      ' Output-level supply accounting on bitcoin-supply.';

    // The transaction is immutable once confirmed, but this page joins utxos —
    // those rows change when an output is spent or the ETL reclassifies
    // loss_bucket. Tied to the ~10min block cadence rather than the tx itself.
    cacheFor(res, 600);

    res.render('transaction', {
      title: `Transaction ${txHash.slice(0, 16)}…`,
      tx,
      utxoMap,
      ...viewHelpers,
    });
  } catch (err) {
    console.error(err);
    renderError(res, 500, 'Failed to load transaction');
  }
});

// GET /address/:addr
router.get('/address/:addr', async (req: Request, res: Response) => {
  try {
    const addr = req.params['addr'];
    const { rows: addrRows } = await pool.query('SELECT * FROM address_info WHERE address = $1', [addr]);
    const addrInfo = addrRows[0] || null;

    const { rows: utxos } = await pool.query(`
      SELECT tx_hash, output_index, value_sats, block_number, block_timestamp,
             loss_rules, loss_bucket, pubkey_exposed, script_type
      FROM utxos WHERE address = $1
      ORDER BY value_sats DESC LIMIT 100
    `, [addr]);

    // address_info has exact pre-aggregated totals; the LIMIT-100 sum would
    // understate addresses holding more UTXOs than the page shows.
    const totalBalance = addrInfo
      ? BigInt(addrInfo.utxo_value_sats ?? 0)
      : utxos.reduce((sum: bigint, u: any) => sum + BigInt(u.value_sats), 0n);

    const totalUtxos = addrInfo ? Number(addrInfo.utxo_count) : utxos.length;
    // Includes the live sibling check (022), so an address the ETL has not
    // marked yet, or one never funded, still gets a complete answer.
    const quantum = await addressQuantumStatus(addr, addrInfo);
    const exposureKind: string | null = quantum.kind;
    res.locals.meta.description =
      `Bitcoin address ${shortAddress(addr)}: ${btc8(totalBalance)} BTC unspent across ` +
      `${num(totalUtxos)} UTXO${totalUtxos === 1 ? '' : 's'}` +
      (exposureKind
        ? ' — public key exposed on-chain, making this balance quantum-vulnerable.'
        : '.') +
      ' Supply status on bitcoin-supply.';

    // The most volatile of the three: any receive or spend changes the balance,
    // so this stays under the block cadence rather than at it.
    cacheFor(res, 300);

    res.render('address', {
      title: `Address ${addr.slice(0, 20)}…`,
      addr,
      addrInfo,
      utxos,
      totalUtxos,
      totalBalance: totalBalance.toString(),
      isQuantumVulnerable: exposureKind != null,
      exposureKind,
      exposureChip: exposureKind ? EXPOSURE_KIND_CHIP[exposureKind] ?? 'Q-EXPOSED' : null,
      exposureText: exposureKind ? EXPOSURE_KIND_TEXT[exposureKind] ?? EXPOSURE_KIND_TEXT['pkh'] : null,
      quantum,
      ...viewHelpers,
    });
  } catch (err) {
    console.error(err);
    renderError(res, 500, 'Failed to load address');
  }
});

// GET /quantum - Quantum exposure explorer
// The quantum figures shared by /quantum and /research/quantum, all from the
// hourly snapshot: per-category totals, the mixed-script caveat and the
// Project Eleven comparison.
function quantumFigures(snapshots: Record<string, any>, stats: Record<string, any>) {
  const snapOf = (key: string) => ({
    sats: (snapshots[key]?.total_sats ?? 0n).toString(),
    count: (snapshots[key]?.utxo_count ?? 0n).toString(),
    present: snapshots[key] != null,
  });
  const all = snapOf('quantum_all_exposed');
  const p2pk = snapOf('quantum_p2pk');
  const p2tr = snapOf('quantum_p2tr');
  const p2ms = snapOf('quantum_p2ms');
  const script = snapOf('quantum_exposed_script');
  const pkh = snapshots['quantum_exposed_pkh']
    ? snapOf('quantum_exposed_pkh')
    : { sats: (BigInt(all.sats) - BigInt(p2pk.sats)).toString(), count: '0', present: false };

  // Mixed-script balances (keys revealed, but a hash-preimage branch exists)
  // are inside the script total; surfaced so the caveat is quantifiable.
  // From the hourly snapshot: the live query takes minutes on a cold cache.
  const mixedStat = stats['quantum_script_mixed']?.data;
  const mixed = { sats: mixedStat?.sats ?? '0', addrs: mixedStat?.addrs ?? '0' };

  // Project Eleven splits spent-and-revealed addresses by address type (all
  // P2SH, including P2SH-P2WPKH, is "script"); we split by what was revealed.
  // Only the combined figure is comparable, so that is the row shown.
  const p11 = stats['p11_crosscheck']?.data ?? null;
  const sum = (...xs: (string | undefined)[]) => xs.reduce((s, x) => s + BigInt(x ?? 0), 0n).toString();
  const crossRows = p11 ? [
    { k: 'P2PK', ours: p2pk.sats, theirs: p11.p2pk_sats },
    { k: 'P2TR', ours: p2tr.sats, theirs: p11.p2tr_sats },
    { k: 'P2MS', ours: p2ms.sats, theirs: p11.p2ms_sats },
    { k: 'revealed by a spend (key hash + script)', ours: sum(pkh.sats, script.sats),
      theirs: sum(p11.pkh_reuse_sats, p11.script_reuse_sats) },
    { k: 'total', ours: all.sats, theirs: p11.total_sats },
  ].map(r => ({ ...r, diff: (BigInt(r.ours) - BigInt(r.theirs ?? 0)).toString() })) : [];

  return { all, p2pk, p2tr, p2ms, pkh, script, mixed, p11, crossRows };
}

router.get('/quantum', async (req: Request, res: Response) => {
  try {
    const snapshots = await getAllSnapshots();
    const stats = await getComputedStats(['p11_crosscheck', 'quantum_script_mixed']);
    const { rows: topRows } = await pool.query(`
      SELECT address, utxo_value_sats AS balance, utxo_count, pubkey_exposed_at_block,
             COALESCE(exposure_kind, CASE WHEN is_p2pk THEN 'p2pk' ELSE 'pkh' END) AS exposure_kind
      FROM address_info
      WHERE pubkey_exposed = TRUE AND utxo_count > 0
      ORDER BY utxo_value_sats DESC LIMIT 100
    `);
    const topExposed = topRows.map(r => ({
      ...r, chip: EXPOSURE_KIND_CHIP[r.exposure_kind] ?? 'Q-EXPOSED',
    }));

    const { all, p2pk, p2tr, p2ms, pkh, script, mixed, p11, crossRows } = quantumFigures(snapshots, stats);

    res.locals.meta.description =
      `${btc2(all.sats)} BTC sits in outputs whose public keys are already visible ` +
      `on-chain — P2PK, taproot and bare multisig outputs, plus every address that ` +
      'has revealed its key or script in a spend. Explore what a quantum attacker could reach, key by key.';

    res.render('quantum', {
      title: 'Quantum exposure',
      all, p2pk, p2tr, p2ms, pkh, script,
      mixed,
      topExposed,
      crosscheck: p11, crossRows,
      ...viewHelpers,
    });
  } catch (err) {
    console.error(err);
    renderError(res, 500, 'Failed to load quantum page');
  }
});

// ---------- /research: the findings, in prose ----------
//
// Live figures for the write-up. Everything comes from the hourly snapshot
// (loss_snapshots, computed_stats); nothing here touches utxos or
// address_info, so each page costs two small reads. Findings tied to one
// investigation are written into the templates with their block height.

const RESEARCH_STATS = ['rule_breakdown', 'age_value_matrix', 'quantum_curve',
  'quantum_address_view', 'quantum_script_mixed', 'p11_crosscheck'];

const satsToBtc = (sats: bigint | string) => Number(BigInt(sats)) / 1e8;

// Percent of whole, as a number (0.0140 for 0.014%).
const share = (part: bigint, whole: bigint) =>
  whole > 0n ? Number((part * 100_000_000n) / whole) / 1_000_000 : 0;

// Bar geometry for a horizontal bar chart. Linear by default; log spans whole
// decades so the ticks land on 10 / 100 / 1K ... and a 2,811 BTC bar can sit
// on the same axis as a 3.6M one.
function barScale(values: number[], log = false) {
  const max = Math.max(...values, 0);
  if (!log) return { pos: (v: number) => max > 0 ? (v / max) * 100 : 0, ticks: [] as { pos: number; label: string }[] };
  const positive = values.filter(v => v > 0);
  const lo = Math.floor(Math.log10(Math.min(...positive)));
  const hi = Math.ceil(Math.log10(max));
  const pos = (v: number) => v > 0 ? ((Math.log10(v) - lo) / (hi - lo)) * 100 : 0;
  const ticks = [];
  for (let d = lo; d <= hi; d++) ticks.push({ pos: ((d - lo) / (hi - lo)) * 100, label: compactNum(10 ** d) });
  return { pos, ticks };
}

function compactNum(n: number): string {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n >= 1e7 ? 0 : 2)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return `${+n.toFixed(n >= 1 ? 0 : 2)}`;
}

// Display helpers for the research views (on top of viewHelpers).
const researchHelpers = {
  // 7.15M / 130,010 / 2,811 / 28.96 / 0.0172 — enough precision to read, none to spare.
  btcShort: (sats: bigint | string) => {
    const b = satsToBtc(sats);
    if (b >= 1e6) return `${(b / 1e6).toFixed(2)}M`;
    if (b >= 100) return Math.round(b).toLocaleString('en-US');
    if (b >= 1) return b.toFixed(2);
    return b.toPrecision(3);
  },
  pct: (n: number) => n >= 1 ? n.toFixed(1) : n >= 0.1 ? n.toFixed(2) : n.toPrecision(2),
  // Whole BTC, grouped, signed: for side-by-side comparisons.
  btcInt: (sats: bigint | string) => Math.round(satsToBtc(sats)).toLocaleString('en-US'),
  compactNum,
};

async function researchData() {
  const snapshots = await getAllSnapshots();
  const stats = await getComputedStats(RESEARCH_STATS);
  const sats = (key: string): bigint => BigInt(snapshots[key]?.total_sats ?? 0n);
  const count = (key: string): bigint => BigInt(snapshots[key]?.utxo_count ?? 0n);
  const asOfBlock = snapshots['all_utxos']?.computed_at_block ?? null;

  const supply = sats('all_utxos');
  const provable = sats('provably_lost');
  const probable = sats('probably_lost');          // includes provable
  const breakdown = stats['rule_breakdown']?.data;
  const minerLoss = BigInt(breakdown?.miner_loss?.total_sats ?? 0);
  const minerBlocks = Number(breakdown?.miner_loss?.block_count ?? 0);
  const dormant = DORMANCY_YEARS
    .map(y => ({ years: y, sats: sats(`dormant_${y}y`), count: count(`dormant_${y}y`) }))
    .filter(d => d.sats > 0n);
  const dormant10 = sats('dormant_10y');
  const dormant15 = sats('dormant_15y');

  const q = quantumFigures(snapshots, stats);
  const exposed = BigInt(q.all.sats);
  const exposedCount = BigInt(q.all.count);

  // The 21M frame: what exists, split by fate, plus what is not yet mined.
  const lost = probable;
  const frame = [
    { key: 'lost', label: 'Lost (provably or probably)', sats: lost },
    { key: 'exposed', label: 'Quantum-exposed', sats: exposed },
    { key: 'rest', label: 'Neither', sats: supply - lost - exposed },
    { key: 'unmined', label: 'Not yet mined', sats: CAP_SATS - supply },
  ].map(f => ({ ...f, pct: share(f.sats, CAP_SATS) }));

  // Every rule that tags lost outputs. 015 is the P2PK quantum rule riding on
  // lost P2PK outputs (genesis, the duplicate coinbases) and is left out; 009
  // matches the same 23 outputs as 003. Totals count each output once.
  const rules = (breakdown?.rules ?? [])
    .filter((r: any) => r.rule !== '015')
    .map((r: any) => ({
      rule: r.rule,
      title: RULE_TITLES[r.rule] ?? r.rule,
      category: ruleCategory(r.rule),
      sats: BigInt(r.total_sats),
      count: BigInt(r.utxo_count),
      years: r.first_year === r.last_year ? `${r.first_year}` : `${r.first_year}–${r.last_year}`,
      overlap: r.rule === '009' ? '003' : null,
    }))
    .sort((a: any, b: any) => (b.sats > a.sats ? 1 : b.sats < a.sats ? -1 : 0));
  // Rules holding under 1 BTC are folded into one row: five of them together
  // are a fraction of a coin, and their percentages would read as noise.
  const provableAll = rules.filter((r: any) => r.category === 'provable' && !r.overlap);
  const minor = provableAll.filter((r: any) => r.sats < 100_000_000n);
  const provableRules = [
    ...provableAll.filter((r: any) => r.sats >= 100_000_000n),
    ...(minor.length ? [{
      rule: minor.map((r: any) => r.rule).join(' '),
      title: `${minor.length} other rules`,
      sats: minor.reduce((a: bigint, r: any) => a + r.sats, 0n),
      count: minor.reduce((a: bigint, r: any) => a + r.count, 0n),
      minor: true,
    }] : []),
  ];
  const provableScale = barScale(provableRules.map((r: any) => satsToBtc(r.sats)));
  const provableBars = provableRules.map((r: any) => ({ ...r, w: provableScale.pos(satsToBtc(r.sats)), pct: share(r.sats, provable) }));

  // Certain vs debatable, on one log axis.
  const scaleRows = [
    { label: 'Provably lost', sats: provable, tone: 'red' },
    { label: 'Probably lost (incl. provable)', sats: probable, tone: 'red' },
    { label: 'Never created: unclaimed miner rewards', sats: minerLoss, tone: 'red' },
    { label: 'Untouched 15+ years', sats: dormant15, tone: 'ink' },
    { label: 'Untouched 10+ years', sats: dormant10, tone: 'ink' },
  ];
  const lossScale = barScale(scaleRows.map(r => satsToBtc(r.sats)), true);
  const scaleBars = { rows: scaleRows.map(r => ({ ...r, w: lossScale.pos(satsToBtc(r.sats)) })), ticks: lossScale.ticks };

  const dormantScale = barScale(dormant.map(d => satsToBtc(d.sats)));
  const dormantCols = dormant.map(d => ({ ...d, h: dormantScale.pos(satsToBtc(d.sats)), pct: share(d.sats, supply) }));

  // Age x value matrix (value bands x age bands), shaded by BTC.
  const m = stats['age_value_matrix']?.data;
  const matrix = m ? (() => {
    const btc = m.btc.map((row: string[]) => row.map(v => BigInt(v)));
    const max = btc.flat().reduce((a: bigint, b: bigint) => (b > a ? b : a), 0n);
    return {
      valueBands: ['≥ 100 BTC', '1–100 BTC', '0.01–1 BTC', '< 0.01 BTC'],
      ageBands: ['< 1 year', '1–5 years', '5–10 years', '≥ 10 years'],
      cells: btc.map((row: bigint[], i: number) => row.map((v: bigint, j: number) => ({
        sats: v, count: BigInt(m.count[i][j]), a: max > 0n ? Number((v * 1000n) / max) / 1000 : 0,
      }))),
    };
  })() : null;

  // Exposed coin by category: share of value vs share of outputs.
  const categories = [
    { k: 'Key hash: P2PKH, P2WPKH, P2SH-P2WPKH', rules: '016 · 022', ...q.pkh },
    { k: 'Pay-to-pubkey (P2PK)', rules: '015', ...q.p2pk },
    { k: 'Script: P2SH, P2WSH', rules: '021', ...q.script },
    { k: 'Taproot (P2TR)', rules: '019', ...q.p2tr },
    { k: 'Bare multisig (P2MS)', rules: '020', ...q.p2ms },
  ].map(c => ({
    ...c,
    satsPct: share(BigInt(c.sats), exposed),
    countPct: share(BigInt(c.count), exposedCount),
  }));
  const catMax = Math.max(...categories.flatMap(c => [c.satsPct, c.countPct]));
  const categoryBars = categories.map(c => ({ ...c, ws: (c.satsPct / catMax) * 100, wc: (c.countPct / catMax) * 100 }));

  // Concentration: the outputs ranked largest first, cumulative share of the
  // exposed total, and the addresses (or keyless outputs) they belong to.
  const curve = stats['quantum_curve']?.data;
  const curveTotal = BigInt(curve?.total_sats ?? 0);
  const concentration = (curve?.breakpoints ?? []).map((bp: any) => ({
    keys: BigInt(bp.key_count),
    outputs: BigInt(bp.utxo_count),
    sats: BigInt(bp.cum_sats),
    minSats: BigInt(bp.min_value_sats),
    pct: share(BigInt(bp.cum_sats), curveTotal),
  // The curve also breaks at whole-coinbase values (50 BTC); a point less than
  // a percentage point past its neighbour adds a row and no information.
  })).filter((c: any, i: number, all: any[]) => i === 0 || i === all.length - 1 || c.pct - all[i - 1].pct >= 1);

  // Exposed balance by the year the key went public (spend-revealed only).
  // Version 1 of this stat mapped heights to years wrongly; hide it until the
  // ETL has recomputed it.
  const view = stats['quantum_address_view'];
  const years = view?.data?.v === 2 ? (() => {
    const by = new Map<number, { pkh: bigint; script: bigint }>();
    for (const r of view.data.by_exposure_year) {
      const y = Number(r.yr);
      const acc = by.get(y) ?? { pkh: 0n, script: 0n };
      acc[r.class === 'script' ? 'script' : 'pkh'] += BigInt(r.total_sats);
      by.set(y, acc);
    }
    const ys = [...by.keys()].sort((a, b) => a - b);
    const rows = [];
    for (let y = ys[0]; y <= ys[ys.length - 1]; y++) rows.push({ year: y, ...(by.get(y) ?? { pkh: 0n, script: 0n }) });
    const max = Math.max(...rows.map(r => satsToBtc(r.pkh + r.script)));
    const ticks = [0.25, 0.5, 0.75, 1].map(f => ({ pos: f * 100, label: compactNum(max * f) }));
    const total = rows.reduce((a, r) => a + r.pkh + r.script, 0n);
    const last = rows[rows.length - 1].year;
    const recent = rows.filter(r => r.year > last - 10).reduce((a, r) => a + r.pkh + r.script, 0n);
    const peak = rows.reduce((a, r) => (r.pkh + r.script > a.pkh + a.script ? r : a));
    return {
      rows: rows.map(r => ({ ...r, hp: (satsToBtc(r.pkh) / max) * 100, hs: (satsToBtc(r.script) / max) * 100 })),
      ticks, asOfBlock: view.computed_at_block,
      recentPct: share(recent, total), peakYear: peak.year,
    };
  })() : null;
  const reuse = (view?.data?.addresses_by_kind ?? []).find((k: any) => k.kind === 'reuse') ?? null;
  const reuseAsOf = view?.computed_at_block ?? null;

  return {
    asOfBlock, supply, capPct: share(supply, CAP_SATS), provable, probable, probableOnly: probable - provable, minerLoss, minerBlocks,
    dormant10, dormant15, exposed, exposedCount, frame, rules, provableBars, scaleBars, dormantCols,
    matrix, categoryBars, concentration, years, reuse, reuseAsOf, q,
    sharePct: (part: bigint, whole: bigint = supply) => share(part, whole),
  };
}

router.get('/research', async (req: Request, res: Response) => {
  try {
    const d = await researchData();
    res.locals.meta.description =
      'What bitcoin-supply.com measures and what it found: how much of the 21M cap is ' +
      'lost (provably, probably, or just dormant) and how much sits behind public keys ' +
      'a quantum computer could break, computed output by output.';
    res.render('research/index', { title: 'Research', ...d, ...viewHelpers, ...researchHelpers });
  } catch (err) {
    console.error(err);
    renderError(res, 500, 'Failed to load research page');
  }
});

router.get('/research/lost-coins', async (req: Request, res: Response) => {
  try {
    const d = await researchData();
    res.locals.meta.description =
      `Only ${researchHelpers.btcShort(d.provable)} BTC is provably lost; ` +
      `${researchHelpers.btcShort(d.dormant10)} BTC has not moved in a decade. ` +
      'The findings behind both numbers, rule by rule, and why the gap matters.';
    res.render('research/lost-coins', { title: 'Lost coins', ...d, ...viewHelpers, ...researchHelpers });
  } catch (err) {
    console.error(err);
    renderError(res, 500, 'Failed to load research page');
  }
});

router.get('/research/quantum', async (req: Request, res: Response) => {
  try {
    const d = await researchData();
    res.locals.meta.description =
      `${researchHelpers.btcShort(d.exposed)} BTC sits behind public keys already on-chain. ` +
      'Where it is, how we measured it, how to check your own addresses, and which ' +
      'address types keep a key hidden.';
    res.render('research/quantum', { title: 'Quantum exposure research', ...d, ...viewHelpers, ...researchHelpers });
  } catch (err) {
    console.error(err);
    renderError(res, 500, 'Failed to load research page');
  }
});

interface ProposalMeta {
  id: string;
  file: string;
  title: string;
  fields: Record<string, string>;
}

// Memoized: this walks the proposals directory and re-parses every markdown
// file synchronously, blocking the event loop. The files only change on deploy,
// so once per process is enough.
let proposalsMemo: ProposalMeta[] | null = null;

function readProposals(): ProposalMeta[] {
  if (proposalsMemo) return proposalsMemo;
  const proposalsDir = path.join(process.cwd(), 'proposals');
  const files = fs.readdirSync(proposalsDir).filter(f => f.endsWith('.md')).sort();
  proposalsMemo = files.map(file => {
    const content = fs.readFileSync(path.join(proposalsDir, file), 'utf8');
    const lines = content.split('\n');
    const title = (lines[0]?.replace(/^#+\s*/, '') ?? file)
      .replace(/^Proposal\s+\d+\s*[:—-]\s*/i, '');
    const fields: Record<string, string> = {};
    for (const m of content.matchAll(/^\|\s*([^|\n]+?)\s*\|\s*([^|\n]+?)\s*\|\s*$/gm)) {
      const key = m[1].trim();
      if (/^[-: ]+$/.test(key) || /^field$/i.test(key)) continue;
      fields[key] = m[2].trim();
    }
    return { id: file.slice(0, 3), file, title, fields };
  });
  return proposalsMemo;
}

// GET /proposals - Classification rule index
router.get('/proposals', (req: Request, res: Response) => {
  try {
    const proposals = readProposals().map(p => ({
      id: p.id,
      title: p.title,
      status: (p.fields['Status'] ?? 'Draft').toUpperCase(),
      category: (p.fields['Category'] ?? '').toUpperCase(),
      scale: p.fields['Scale Estimate'] ?? '—',
      chipClass: CATEGORY_CHIP_CLASS[(p.fields['Category'] ?? '').toUpperCase()] ?? 'chip--gray',
    }));
    res.locals.meta.description =
      `The bitcoin-supply rulebook: ${num(proposals.length)} proposals defining ` +
      'exactly which coins count as provably lost, probably lost or ' +
      'quantum-exposed — each with rationale, scale estimate and status.';
    res.render('proposals', { title: 'Proposals', proposals, ...viewHelpers });
  } catch (err) {
    console.error(err);
    renderError(res, 500, 'Failed to load proposals');
  }
});

// GET /proposals/:id.md - the raw proposal markdown.
//
// The classification rules are the substance of this site, and they are already
// authored as markdown — this hands them to an LLM (or anyone) in their native
// form, front-matter table and all, instead of making them scrape the rendered
// page. Must be registered before /proposals/:id, which would otherwise match
// "004.md" as the id. The file is looked up via readProposals() by validated
// 3-digit id, never built from the raw param, so there is no path traversal.
router.get('/proposals/:id.md', (req: Request, res: Response) => {
  try {
    const id = (req.params['id'] ?? '').slice(0, 3);
    const meta = readProposals().find(p => p.id === id);
    if (!meta) return renderError(res, 404, 'Proposal not found');

    const raw = fs.readFileSync(path.join(process.cwd(), 'proposals', meta.file), 'utf8');
    res.type('text/markdown; charset=utf-8');
    // Changes only on deploy, like the rendered proposal pages.
    res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=10800');
    res.send(raw);
  } catch (err) {
    console.error(err);
    renderError(res, 500, 'Failed to load proposal');
  }
});

// GET /proposals/:id - Proposal detail
router.get('/proposals/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'].slice(0, 3);
    const proposals = readProposals();
    const idx = proposals.findIndex(p => p.id === id);
    if (idx === -1) return renderError(res, 404, 'Proposal not found');
    const meta = proposals[idx];

    const raw = fs.readFileSync(path.join(process.cwd(), 'proposals', meta.file), 'utf8');
    // Strip the H1 and front-matter pipe table; the view renders those itself.
    const body = raw
      .split('\n')
      .filter((line, i) => !(i === 0 && line.startsWith('#')) && !/^\s*\|.*\|\s*$/.test(line))
      .join('\n')
      .trim();
    const html = await marked(body);

    const category = (meta.fields['Category'] ?? '').toUpperCase();
    const metaRows = ['Author', 'Created', 'Scale Estimate', 'First Seen in Block', 'Loss Bucket']
      .map(key => {
        const found = Object.keys(meta.fields).find(k => k.toLowerCase() === key.toLowerCase());
        return found ? { label: key, value: meta.fields[found] } : null;
      })
      .filter(Boolean);

    // First body paragraph, flattened to plain text, as the social summary.
    const firstPara = body
      .split(/\n\s*\n/)
      .map(p => p.trim())
      .find(p => p && !p.startsWith('#'));
    const summary = (firstPara ?? '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const scale = meta.fields['Scale Estimate'];
    res.locals.meta.description =
      `Classification rule ${meta.id}: ${meta.title}` +
      (scale && scale !== '—' ? ` — estimated scale ${scale}.` : '.') +
      (summary ? ` ${summary.length > 180 ? summary.slice(0, 177).trimEnd() + '…' : summary}` : '');

    res.render('proposal', {
      title: meta.title,
      id: meta.id,
      heading: meta.title,
      category,
      chipClass: CATEGORY_CHIP_CLASS[category] ?? 'chip--gray',
      status: (meta.fields['Status'] ?? 'Draft').toUpperCase(),
      metaRows,
      content: html,
      prev: idx > 0 ? { id: proposals[idx - 1].id, title: proposals[idx - 1].title } : null,
      next: idx < proposals.length - 1 ? { id: proposals[idx + 1].id, title: proposals[idx + 1].title } : null,
      ...viewHelpers,
    });
  } catch (err) {
    console.error(err);
    renderError(res, 500, 'Failed to load proposal');
  }
});

// GET /sitemap.xml - the canonical pages only.
//
// Deliberately omits /block/:n, /transaction/:hash and /address/:addr: they are
// an unbounded URL space and expensive to serve, and robots.txt disallows them.
// This file is the positive half of that bargain — it tells crawlers exactly
// what we do want indexed, so being restrictive costs us no discoverability.
router.get('/sitemap.xml', async (req: Request, res: Response) => {
  try {
    const base = config.server.publicUrl;
    // Snapshots are recomputed hourly by the ETL; that is the site's real
    // lastmod, since every aggregate page is rendered from them.
    const stats = await getComputedStats(['rule_breakdown']);
    const computedAt = stats['rule_breakdown']?.computed_at;
    const lastmod = (computedAt ? new Date(computedAt) : new Date()).toISOString();

    const pages: { loc: string; changefreq: string; priority: string }[] = [
      { loc: '/', changefreq: 'hourly', priority: '1.0' },
      { loc: '/losses', changefreq: 'hourly', priority: '0.8' },
      { loc: '/quantum', changefreq: 'hourly', priority: '0.8' },
      { loc: '/utxos', changefreq: 'hourly', priority: '0.8' },
      { loc: '/research', changefreq: 'weekly', priority: '0.8' },
      { loc: '/research/lost-coins', changefreq: 'weekly', priority: '0.7' },
      { loc: '/research/quantum', changefreq: 'weekly', priority: '0.7' },
      { loc: '/proposals', changefreq: 'monthly', priority: '0.6' },
      { loc: '/about', changefreq: 'monthly', priority: '0.5' },
      ...readProposals().map(p => ({
        loc: `/proposals/${p.id}`, changefreq: 'monthly', priority: '0.4',
      })),
    ];

    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      pages.map(p =>
        '  <url>\n' +
        `    <loc>${base}${p.loc}</loc>\n` +
        `    <lastmod>${lastmod}</lastmod>\n` +
        `    <changefreq>${p.changefreq}</changefreq>\n` +
        `    <priority>${p.priority}</priority>\n` +
        '  </url>\n'
      ).join('') +
      '</urlset>\n';

    res.type('application/xml').send(xml);
  } catch (err) {
    console.error(err);
    res.status(500).type('text/plain').send('sitemap unavailable');
  }
});

// GET /llms.txt - an LLM-oriented index of the site (see llmstxt.org).
//
// A curated map: the premise (which a crawler can't infer from a UTXO table),
// then pointers to the canonical pages, the JSON API, and the raw rule files.
// A route, not a static file, so the proposal list stays current and it dodges
// the *.txt gitignore rule. It advertises the structured data we expose so an
// agent never has to scrape HTML.
router.get('/llms.txt', (req: Request, res: Response) => {
  try {
    const base = config.server.publicUrl;
    const proposals = readProposals();

    const md = `# bitcoin-supply.com

> Bitcoin's 21 million cap is a ceiling, not a count of coins in circulation.
> This site measures the *effective* supply: how much BTC is provably lost,
> probably lost, dormant, or exposed to a future quantum attacker — computed
> UTXO by UTXO from a fully-indexed Bitcoin Core node.

Every figure traces to a public, versioned classification rule; nothing is an
estimate unless labelled as one. "Provably lost" is mathematically certain
(coin spent to unspendable conditions, or never claimed by a miner). "Probably
lost" is judged (known burn addresses). "Dormant" is coin untouched for years.
"Quantum-exposed" is a separate lens: spendable coin whose public key is already
revealed on-chain. These are distinct axes — dormant or quantum coin is not
counted as lost.

## Start here

- [About and methodology](${base}/about): what effective supply means and how the figures are computed.
- [Effective supply explorer](${base}/): the headline numbers with interactive loss/quantum sliders.
- [Loss history](${base}/losses): every provably or probably lost output, newest first.
- [Quantum exposure](${base}/quantum): coin sitting behind exposed public keys.
- [Research](${base}/research): the findings in prose, with [lost coins](${base}/research/lost-coins) and [quantum exposure](${base}/research/quantum) in depth, including which address types keep a key hidden.
- [The UTXO set](${base}/utxos): the unspent set by age and value.

## Structured data (JSON API)

Prefer these over scraping HTML. Aggregate endpoints (cached, cheap):

- [Supply stats](${base}/api/v1/stats): circulating vs. lost vs. quantum totals at the current tip.
- [Loss breakdown](${base}/api/v1/loss-breakdown): lost coin grouped by classification rule.
- [Dormancy curve](${base}/api/v1/dormancy-curve): balance by how long it has sat unmoved.
- [Quantum totals](${base}/api/v1/quantum) and [quantum curve](${base}/api/v1/quantum-curve): exposed-key exposure.
- [Concentration](${base}/api/v1/concentration): largest holdings.

Per-entity endpoints (JSON siblings of the deep pages; substitute the parameter):

- \`${base}/api/v1/address/{address}\`: balance, UTXOs, and per-output loss/quantum status for one address.
- \`${base}/api/v1/block/{height}\`: supply accounting (subsidy, fees, miner loss, lost outputs) for one block.
- \`${base}/api/v1/transaction/{txid}\`: outputs with per-output loss classification for one transaction.

## The classification rules

The substance of the site. Each is authored as markdown and served raw at the
\`.md\` URL below (the front-matter table carries status, category, and scale
estimate). The full index is at [${base}/proposals](${base}/proposals).

${proposals.map(p => {
  const status = (p.fields['Status'] ?? 'Draft');
  const scale = (p.fields['Scale Estimate'] ?? '').trim();
  // Show the scale verbatim only when it's an actual figure — the field is
  // free-form and holds placeholders ("xxxx", "TBD", "Variable") and values
  // that already carry their own "~". Never prepend our own approximation mark.
  const hasScale = /\d/.test(scale) && !/x{3,}/i.test(scale);
  const suffix = hasScale ? ` — ${status}, ${scale}` : ` — ${status}`;
  return `- [Proposal ${p.id} — ${p.title}](${base}/proposals/${p.id}.md)${suffix}`;
}).join('\n')}

## Notes for automated clients

- Deep pages (\`/block/*\`, \`/transaction/*\`, \`/address/*\`) are disallowed to bulk crawlers in [robots.txt](${base}/robots.txt) because they are an unbounded, database-heavy URL space. Use the JSON API instead, or fetch a single page when a user asks for it.
- This site is open source: https://github.com/anders94/bitcoin-supply.com — for bulk access, please get in touch rather than scraping.
`;

    res.type('text/markdown; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=10800');
    res.send(md);
  } catch (err) {
    console.error(err);
    res.status(500).type('text/plain').send('llms.txt unavailable');
  }
});

// POST /search - block number, block hash, txid, or address
router.post('/search', async (req: Request, res: Response) => {
  try {
    const query = (req.body?.query as string || '').trim();
    if (!query) return res.redirect('/');

    if (/^\d+$/.test(query)) return res.redirect(`/block/${query}`);

    if (/^[0-9a-fA-F]{64}$/.test(query)) {
      const { rows } = await pool.query('SELECT block_number FROM blocks WHERE block_hash = $1', [query]);
      if (rows.length) return res.redirect(`/block/${rows[0].block_number}`);
      return res.redirect(`/transaction/${query}`);
    }

    // Any valid address, seen or not: the address page answers for unfunded
    // ones too (checking an address before sending to it is the point), and
    // explains a bad checksum for something address-shaped.
    if (isValidAddress(query) || /^(1|3|bc1)[a-zA-Z0-9]{24,88}$/.test(query)) {
      return res.redirect(`/address/${encodeURIComponent(query)}`);
    }
    const { rows } = await pool.query('SELECT address FROM address_info WHERE address = $1', [query]);
    if (rows.length) return res.redirect(`/address/${query}`);

    renderError(res, 404, `Nothing found for: ${query}`);
  } catch (err) {
    console.error(err);
    renderError(res, 500, 'Search failed');
  }
});

router.get('/search', (req: Request, res: Response) => res.redirect('/'));

// Catch-all 404 in the site's own error style.
router.use((req: Request, res: Response) => renderError(res, 404, 'Page not found'));

export default router;
