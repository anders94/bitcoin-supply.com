import { pool } from '../db/index.js';
import { upsertSnapshot } from '../db/snapshots.js';
import { upsertComputedStat } from '../db/computed-stats.js';
import { RULE_TITLES } from '../helpers/breakdown.js';

const DORMANCY_YEARS = [1, 3, 5, 7, 10, 15, 20];
const YEAR_SECONDS = 31557600; // 365.25 days
const HALVING_INTERVAL = 210_000;

// Quantum-curve breakpoints as fractions of the total exposed value. Dense at
// the head where the largest keys concentrate most of the capturable value.
const CURVE_FRACTIONS = [
  0.001, 0.0025, 0.005, 0.01, 0.02, 0.05,
  0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9,
];

interface GroupRow {
  loss_bucket: number;
  pubkey_exposed: boolean;
  value_band: number; // 0: >=100 BTC, 1: 1-100, 2: 0.01-1, 3: <0.01
  age_years: number;  // full years since creation, clamped to [0, 25]
  total_sats: string;
  utxo_count: string;
}

async function stage(name: string, fn: () => Promise<void>): Promise<boolean> {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ${name}: ok (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return true;
  } catch (err) {
    console.error(`  ${name}: FAILED`, err);
    return false;
  }
}

export async function updateSnapshots(): Promise<void> {
  const { rows: tipRows } = await pool.query(
    'SELECT block_number, block_timestamp FROM blocks ORDER BY block_number DESC LIMIT 1'
  );
  if (!tipRows.length) return;
  const tipBlock: number = tipRows[0].block_number;
  const tipTs: Date = new Date(tipRows[0].block_timestamp);

  console.log(`Updating snapshots at block ${tipBlock}...`);

  await stage('supply scan (snapshots + matrix + history)', () => supplyScan(tipBlock, tipTs));
  const breakdown = { rules: [] as any[], miner_loss: { total_sats: '0', block_count: '0' } };
  await stage('rule breakdown', () => ruleBreakdown(tipBlock, breakdown));
  await stage('quantum curve', () => quantumCurve(tipBlock));
  await stage('top losses', () => topLosses(tipBlock, breakdown));
  await stage('halvings', () => halvings(tipBlock, tipTs));
  await stage('dormant giants', () => dormantGiants(tipBlock, tipTs));

  console.log(`Snapshots updated at block ${tipBlock}`);
}

// One grouped pass over the whole utxos table. Feeds every loss_snapshots key,
// the /utxos age-x-value matrix, and today's snapshot_history rows.
async function supplyScan(tipBlock: number, tipTs: Date): Promise<void> {
  const { rows } = await pool.query<GroupRow>(`
    SELECT loss_bucket, pubkey_exposed,
           CASE WHEN value_sats >= 10000000000 THEN 0
                WHEN value_sats >= 100000000   THEN 1
                WHEN value_sats >= 1000000     THEN 2
                ELSE 3 END AS value_band,
           GREATEST(LEAST(FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - block_timestamp)) / ${YEAR_SECONDS}), 25), 0)::int AS age_years,
           SUM(value_sats)::text AS total_sats,
           COUNT(*)::text AS utxo_count
    FROM utxos
    GROUP BY 1, 2, 3, 4
  `, [tipTs]);

  const zero = () => ({ sats: 0n, count: 0n });
  const add = (acc: { sats: bigint; count: bigint }, row: GroupRow) => {
    acc.sats += BigInt(row.total_sats);
    acc.count += BigInt(row.utxo_count);
  };

  const all = zero();
  const provable = zero();
  const probable = zero();
  const p2pk = zero();
  const exposed = zero();
  const dormant = DORMANCY_YEARS.map(() => zero());
  // matrix[value_band][age_band], age bands: <1y / 1-5y / 5-10y / >=10y
  const matrixSats = Array.from({ length: 4 }, () => [0n, 0n, 0n, 0n]);
  const matrixCount = Array.from({ length: 4 }, () => [0n, 0n, 0n, 0n]);

  for (const row of rows) {
    add(all, row);
    if (row.loss_bucket === 1) add(provable, row);
    if (row.loss_bucket === 1 || row.loss_bucket === 2) add(probable, row);
    if (row.loss_bucket === 4) add(p2pk, row);
    if (row.pubkey_exposed) add(exposed, row);
    if (row.loss_bucket === 0 || row.loss_bucket === 4) {
      DORMANCY_YEARS.forEach((years, i) => {
        if (row.age_years >= years) add(dormant[i], row);
      });
    }
    const ageBand = row.age_years < 1 ? 0 : row.age_years < 5 ? 1 : row.age_years < 10 ? 2 : 3;
    matrixSats[row.value_band][ageBand] += BigInt(row.total_sats);
    matrixCount[row.value_band][ageBand] += BigInt(row.utxo_count);
  }

  const snaps: [string, { sats: bigint; count: bigint }][] = [
    ['all_utxos', all],
    ['provably_lost', provable],
    ['probably_lost', probable],
    ['quantum_p2pk', p2pk],
    ['quantum_all_exposed', exposed],
    ...DORMANCY_YEARS.map((years, i) => [`dormant_${years}y`, dormant[i]] as [string, { sats: bigint; count: bigint }]),
  ];
  for (const [key, agg] of snaps) {
    await upsertSnapshot({ snapshot_key: key, total_sats: agg.sats, utxo_count: agg.count, computed_at_block: tipBlock });
  }

  await upsertComputedStat('age_value_matrix', {
    btc: matrixSats.map(r => r.map(String)),
    count: matrixCount.map(r => r.map(String)),
  }, tipBlock);

  // Today's history rows (daily granularity; last write of the day wins).
  for (const [key, agg] of [['provably_lost', provable], ['probably_lost', probable], ['all_utxos', all]] as const) {
    await pool.query(`
      INSERT INTO snapshot_history (as_of_date, snapshot_key, total_sats, utxo_count, computed_at_block, computed_at)
      VALUES (CURRENT_DATE, $1, $2, $3, $4, now())
      ON CONFLICT (as_of_date, snapshot_key) DO UPDATE SET
        total_sats = $2, utxo_count = $3, computed_at_block = $4, computed_at = now()
    `, [key, agg.sats, agg.count, tipBlock]);
  }
}

// Per-rule totals over loss UTXOs plus block-level miner loss (rule 002).
async function ruleBreakdown(tipBlock: number, out: { rules: any[]; miner_loss: any }): Promise<void> {
  const { rows } = await pool.query(`
    SELECT rule, SUM(value_sats)::text AS total_sats, COUNT(*)::text AS utxo_count,
           MIN(EXTRACT(YEAR FROM block_timestamp))::int AS first_year,
           MAX(EXTRACT(YEAR FROM block_timestamp))::int AS last_year
    FROM (SELECT unnest(loss_rules) AS rule, value_sats, block_timestamp
          FROM utxos WHERE loss_bucket IN (1, 2)) t
    GROUP BY rule ORDER BY rule
  `);

  const { rows: miner } = await pool.query(`
    SELECT COALESCE(SUM(miner_loss_sats), 0)::text AS total_sats,
           COUNT(*) FILTER (WHERE miner_loss_sats > 0)::text AS block_count
    FROM blocks
  `);

  out.rules = rows;
  out.miner_loss = miner[0];
  await upsertComputedStat('rule_breakdown', out, tipBlock);
}

// Cumulative attacker-capture curve over exposed outputs, largest value first.
// Breakpoints are cumulative-capture caps at fractions of the exposed total.
async function quantumCurve(tipBlock: number): Promise<void> {
  const { rows: totalRows } = await pool.query(
    `SELECT COALESCE(SUM(value_sats), 0)::text AS total FROM utxos WHERE pubkey_exposed = TRUE`
  );
  const total = BigInt(totalRows[0].total);
  if (total === 0n) {
    await upsertComputedStat('quantum_curve', { breakpoints: [] }, tipBlock);
    return;
  }

  const caps = CURVE_FRACTIONS.map(f => (total * BigInt(Math.round(f * 1e6))) / 1_000_000n);
  const aggs = caps.map((cap, i) => `
    COUNT(*) FILTER (WHERE cumulative <= ${cap}) AS utxo_count_${i},
    SUM(value_sats) FILTER (WHERE cumulative <= ${cap}) AS total_sats_${i},
    COUNT(DISTINCT address) FILTER (WHERE cumulative <= ${cap}) AS addr_count_${i},
    COUNT(*) FILTER (WHERE address IS NULL AND cumulative <= ${cap}) AS keyless_count_${i},
    MIN(value_sats) FILTER (WHERE cumulative <= ${cap}) AS min_sats_${i}`).join(',');

  const { rows } = await pool.query(`
    WITH ranked AS (
      SELECT address, value_sats,
             SUM(value_sats) OVER (ORDER BY value_sats DESC) AS cumulative
      FROM utxos WHERE pubkey_exposed = TRUE
    )
    SELECT ${aggs},
      COUNT(*) AS utxo_count_max,
      COALESCE(SUM(value_sats), 0) AS total_sats_max,
      COUNT(DISTINCT address) AS addr_count_max,
      COUNT(*) FILTER (WHERE address IS NULL) AS keyless_count_max,
      MIN(value_sats) AS min_sats_max
    FROM ranked
  `);

  const r = rows[0];
  // "Keys broken" counts one key per address plus one per addressless output (P2PK).
  const point = (suffix: string | number) => ({
    cum_sats: (r[`total_sats_${suffix}`] ?? '0').toString(),
    utxo_count: r[`utxo_count_${suffix}`].toString(),
    key_count: (BigInt(r[`addr_count_${suffix}`]) + BigInt(r[`keyless_count_${suffix}`])).toString(),
    min_value_sats: (r[`min_sats_${suffix}`] ?? '0').toString(),
  });

  const breakpoints = CURVE_FRACTIONS.map((_, i) => point(i))
    .filter(bp => bp.utxo_count !== '0');
  breakpoints.push(point('max'));
  // De-duplicate identical cumulative positions (tiny fractions can coincide).
  const deduped = breakpoints.filter((bp, i) => i === 0 || bp.cum_sats !== breakpoints[i - 1].cum_sats);

  await upsertComputedStat('quantum_curve', { total_sats: total.toString(), breakpoints: deduped }, tipBlock);
}

// Largest all-time loss events: grouped rule events, individual loss UTXOs,
// burns grouped per address, and the biggest miner underclaims.
async function topLosses(tipBlock: number, breakdown: { rules: any[] }): Promise<void> {
  type Entry = { label: string; rule: string; total_sats: bigint; year_label: string; href: string | null };
  const entries: Entry[] = [];
  const yearLabel = (y0: number, y1: number) => (y0 === y1 ? String(y0) : `${y0}–`);

  // Grouped one-off rule events (each is a single historical episode).
  for (const rule of ['000', '001', '003']) {
    const row = breakdown.rules.find(r => r.rule === rule);
    if (row && row.total_sats !== '0') {
      entries.push({
        label: RULE_TITLES[rule], rule,
        total_sats: BigInt(row.total_sats),
        year_label: yearLabel(row.first_year, row.last_year),
        href: null,
      });
    }
  }

  // Largest individual loss UTXOs (skip rules covered by grouped entries).
  const { rows: utxoRows } = await pool.query(`
    SELECT tx_hash, value_sats::text, block_number, loss_rules,
           EXTRACT(YEAR FROM block_timestamp)::int AS year
    FROM utxos WHERE loss_bucket IN (1, 2)
    ORDER BY value_sats DESC LIMIT 25
  `);
  const grouped = new Set(['000', '001', '003', '012']);
  for (const row of utxoRows) {
    const rule = (row.loss_rules as string[]).find(r => !grouped.has(r));
    if (!rule) continue;
    entries.push({
      label: RULE_TITLES[rule] ?? `Rule ${rule}`, rule,
      total_sats: BigInt(row.value_sats),
      year_label: String(row.year),
      href: `/transaction/${row.tx_hash}`,
    });
  }

  // Burns aggregated per known burn address.
  const { rows: burnRows } = await pool.query(`
    SELECT COALESCE(k.label, u.address) AS label, u.address,
           SUM(u.value_sats)::text AS total_sats,
           MIN(EXTRACT(YEAR FROM u.block_timestamp))::int AS first_year,
           MAX(EXTRACT(YEAR FROM u.block_timestamp))::int AS last_year
    FROM utxos u JOIN known_burn_addresses k ON k.address = u.address
    WHERE u.loss_rules @> '{012}'
    GROUP BY 1, 2 ORDER BY SUM(u.value_sats) DESC LIMIT 10
  `);
  for (const row of burnRows) {
    entries.push({
      label: row.label, rule: '012',
      total_sats: BigInt(row.total_sats),
      year_label: yearLabel(row.first_year, row.last_year),
      href: `/address/${row.address}`,
    });
  }

  // Largest miner underclaims (rule 002).
  const { rows: minerRows } = await pool.query(`
    SELECT block_number, miner_loss_sats::text,
           EXTRACT(YEAR FROM block_timestamp)::int AS year
    FROM blocks WHERE miner_loss_sats > 0
    ORDER BY miner_loss_sats DESC LIMIT 5
  `);
  for (const row of minerRows) {
    entries.push({
      label: `Block ${Number(row.block_number).toLocaleString('en-US')} reward missed`, rule: '002',
      total_sats: BigInt(row.miner_loss_sats),
      year_label: String(row.year),
      href: `/block/${row.block_number}`,
    });
  }

  entries.sort((a, b) => (b.total_sats > a.total_sats ? 1 : b.total_sats < a.total_sats ? -1 : 0));
  const top = entries.slice(0, 10).map((e, i) => ({
    rank: i + 1, label: e.label, rule: e.rule,
    total_sats: e.total_sats.toString(), year_label: e.year_label, href: e.href,
  }));

  await upsertComputedStat('top_losses', { entries: top }, tipBlock);
}

async function halvings(tipBlock: number, tipTs: Date): Promise<void> {
  const past: number[] = [];
  for (let h = HALVING_INTERVAL; h <= tipBlock; h += HALVING_INTERVAL) past.push(h);

  const { rows } = await pool.query(
    `SELECT block_number, block_timestamp FROM blocks WHERE block_number = ANY($1)`,
    [past]
  );
  const byHeight = new Map(rows.map(r => [Number(r.block_number), r.block_timestamp]));

  const subsidyBtc = (era: number) => 50 / Math.pow(2, era); // era 0 = first 210k blocks
  const events = past.map(h => {
    const era = h / HALVING_INTERVAL; // era starting AT this height
    return {
      height: h,
      timestamp: byHeight.get(h) ?? null,
      estimated: false,
      from_subsidy: String(subsidyBtc(era - 1)),
      to_subsidy: String(subsidyBtc(era)),
    };
  }).reverse();

  const nextHeight = (Math.floor(tipBlock / HALVING_INTERVAL) + 1) * HALVING_INTERVAL;
  const nextEra = nextHeight / HALVING_INTERVAL;
  events.unshift({
    height: nextHeight,
    timestamp: new Date(tipTs.getTime() + (nextHeight - tipBlock) * 600_000).toISOString() as any,
    estimated: true,
    from_subsidy: String(subsidyBtc(nextEra - 1)),
    to_subsidy: String(subsidyBtc(nextEra)),
  });

  await upsertComputedStat('halvings', { events }, tipBlock);
}

// Largest balances that have not moved in years, for the /utxos page.
async function dormantGiants(tipBlock: number, tipTs: Date): Promise<void> {
  const { rows } = await pool.query(`
    SELECT a.address, a.utxo_value_sats::text AS balance, a.utxo_count,
           a.pubkey_exposed, a.is_p2pk, b.block_timestamp AS last_active_ts
    FROM address_info a
    LEFT JOIN blocks b ON b.block_number = COALESCE(a.last_active_block, a.first_seen_block)
    WHERE a.utxo_count > 0
    ORDER BY a.utxo_value_sats DESC LIMIT 200
  `);

  const giants = rows
    .map(r => {
      const age = r.last_active_ts
        ? Math.floor((tipTs.getTime() - new Date(r.last_active_ts).getTime()) / (YEAR_SECONDS * 1000))
        : 0;
      return {
        address: r.address,
        balance: r.balance,
        age_years: age,
        chip: r.is_p2pk ? 'P2PK' : r.pubkey_exposed ? 'Q-EXPOSED' : 'HASHED',
      };
    })
    .filter(g => g.age_years >= 5)
    .slice(0, 12);

  await upsertComputedStat('dormant_giants', { giants }, tipBlock);
}
