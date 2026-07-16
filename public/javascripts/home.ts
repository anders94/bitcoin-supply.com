// Homepage sliders — spectrum, dormancy, quantum attack capture.
// All data is SSR-embedded in window.__SUPPLY__; no fetches. Math is the
// design prototype's calc2 ported to real sats-string data.

import noUiSlider from 'nouislider';
import 'nouislider/dist/nouislider.css';
import { btcParts, btc8, fmtNum } from './lib/format.js';
import { interp } from './lib/interp.js';

interface SupplyPayload {
  tip: { height: number; timestamp: string };
  cap_sats: string;
  all_sats: string; all_count: string;
  provable_sats: string; provable_count: string;
  probable_sats: string; probable_count: string;
  miner_never_claimed_sats: string;
  dormancy: { years: number; sats: string; count: string }[];
  breakdown: {
    provable: { rules: string[]; label: string; sats: string; count: string }[];
    probable: { rules: string[]; label: string; sats: string; count: string }[];
  };
  quantum: {
    p2pk_sats: string; exposed_pkh_sats: string; total_sats: string; total_keys: string;
    curve: { cum_sats: string; key_count: string; min_value_sats: string }[];
  };
  computed_at: string;
}

declare global {
  interface Window { __SUPPLY__: SupplyPayload; }
}

const S = window.__SUPPLY__;
if (S) init();

function init() {
  const CAP = Number(S.cap_sats);
  const ALL = BigInt(S.all_sats);
  const PROV = BigInt(S.provable_sats);
  const PROB = BigInt(S.probable_sats);
  const YEARS = S.dormancy.map(d => d.years);
  const QTOT = Number(S.quantum.total_sats);

  const keyTbl: [number, number][] = [[0, 0], ...S.quantum.curve.map(
    bp => [Number(bp.cum_sats), Number(bp.key_count)] as [number, number])];
  const minTbl: [number, number][] = S.quantum.curve.map(
    bp => [Number(bp.cum_sats), Number(bp.min_value_sats)] as [number, number]);

  const state = { stop: 1, y: 4, q: 300 }; // q is 0..1000 of total exposed

  const $ = (id: string) => document.getElementById(id)!;

  const DESCS = [
    'Trustfully inclusive — assume even provably unspendable coin might somehow be claimed.',
    'Mathematically certain only: outputs spent to unspendable conditions. The default view.',
    'Adds known burn addresses and anyone-can-spend outputs dormant 3+ years.',
    '', // dormant text is year-dependent, built in render()
    'Absurdly inclusive — every unspent output counted out of circulation.',
  ];
  const STOP_LABELS = [
    'nothing', 'provably lost', 'provably + probably lost', '', 'everything',
  ];

  function render() {
    const y = state.y;
    const dorm = BigInt(S.dormancy[y].sats);
    const stops = [0n, PROV, PROB, PROB + dorm, ALL];
    const ooc = stops[state.stop];
    const eff = ALL - ooc;
    const oocN = Number(ooc);
    const effN = Number(eff);

    // hero
    const p = btcParts(eff);
    $('hero-int').textContent = p.int;
    $('hero-dec').textContent = '.' + p.dec;
    const stopLabel = state.stop === 3
      ? `provably + probably + dormant ≥${YEARS[y]}y`
      : STOP_LABELS[state.stop];
    $('hero-redline').textContent = `−${btc8(ooc)} out of circulation · ${stopLabel}`;
    const subOoc = document.getElementById('hero-sub-ooc');
    if (subOoc) subOoc.textContent = `−${btc8(ooc)}`;

    // quantum values (needed for bar + readouts)
    const cap = state.q / 1000 * QTOT;
    const keys = Math.round(interp(keyTbl, cap));
    const minw = minTbl.length ? interp(minTbl, cap) : 0;

    // bar
    $('bar-eff').style.width = (effN / CAP * 100).toFixed(3) + '%';
    $('bar-ooc').style.width = oocN > 0 ? Math.max(0.45, oocN / CAP * 100).toFixed(3) + '%' : '0%';
    $('bar-hatch').style.width = effN > 0 ? (cap / effN * 100).toFixed(2) + '%' : '0%';

    // spectrum section
    $('spectrum-ooc').textContent = `−${btc8(ooc)}`;
    document.querySelectorAll('#spectrum-stops span').forEach(el => {
      el.classList.toggle('active', Number((el as HTMLElement).dataset.stop) === state.stop);
    });
    ($('dormancy-panel') as HTMLElement).hidden = state.stop !== 3;
    $('dormancy-label').textContent = `DORMANCY THRESHOLD · ≥ ${YEARS[y]}Y`;
    document.querySelectorAll('#dormancy-stops span').forEach(el => {
      el.classList.toggle('active', Number((el as HTMLElement).dataset.year) === y);
    });
    $('stop-desc').textContent = state.stop === 3
      ? `Adds every UTXO untouched for ${YEARS[y]}+ years — tune the threshold below.`
      : DESCS[state.stop];

    // breakdown groups
    const groupOn: Record<string, boolean> = {
      provable: state.stop >= 1,
      probable: state.stop >= 2,
      dormant: state.stop >= 3,
      active: state.stop >= 4,
    };
    document.querySelectorAll<HTMLElement>('#breakdown [data-group]').forEach(el => {
      el.classList.toggle('dim', !groupOn[el.dataset.group!]);
    });
    $('dormant-row-label').textContent = `Untouched ≥ ${YEARS[y]}y · incl. Satoshi-era`;
    $('dormant-row-value').textContent = fmtNum(Number(dorm) / 1e8, 2);
    $('active-row-label').textContent = `Active UTXOs (moved < ${YEARS[y]}y)`;
    $('active-row-value').textContent = fmtNum(Number(ALL - PROB - dorm) / 1e8, 2);
    $('ooc-total').textContent = `${btc8(ooc)} · ${fmtNum(oocN / Number(ALL) * 100, 3)}%`;

    // quantum readouts
    $('q-pct').textContent = QTOT > 0 ? fmtNum(cap / QTOT * 100, 1) + '%' : '0%';
    $('q-captured').textContent = fmtNum(cap / 1e8, 2);
    $('q-keys').textContent = keys.toLocaleString('en-US');
    const minwBtc = minw / 1e8;
    $('q-minworth').textContent = minwBtc >= 1 ? fmtNum(minwBtc, 2) + ' BTC' : minwBtc.toFixed(5) + ' BTC';
    $('q-effafter').textContent = fmtNum(Math.max(effN - cap, 0) / 1e8, 2);
    const subQ = document.getElementById('hero-sub-q');
    if (subQ) subQ.textContent = fmtNum(cap / 1e8, 2);
  }

  function makeSlider(id: string, start: number, max: number, step: number, onUpdate: (v: number) => void) {
    const el = $(id);
    const slider = noUiSlider.create(el, {
      start, step,
      range: { min: 0, max },
      connect: false,
    });
    slider.on('update', (values) => onUpdate(Number(values[0])));
    return slider;
  }

  const spectrumSlider = makeSlider('spectrum-slider', state.stop, 4, 1, v => {
    if (v !== state.stop) { state.stop = v; render(); }
  });
  const dormancySlider = makeSlider('dormancy-slider', state.y, 6, 1, v => {
    if (v !== state.y) { state.y = v; render(); }
  });
  makeSlider('quantum-slider', state.q, 1000, 1, v => {
    if (v !== state.q) { state.q = v; render(); }
  });

  document.querySelectorAll<HTMLElement>('#spectrum-stops span').forEach(el => {
    el.addEventListener('click', () => spectrumSlider.set(Number(el.dataset.stop)));
  });
  document.querySelectorAll<HTMLElement>('#dormancy-stops span').forEach(el => {
    el.addEventListener('click', () => dormancySlider.set(Number(el.dataset.year)));
  });

  render();
}
