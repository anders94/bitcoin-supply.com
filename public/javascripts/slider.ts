// @ts-nocheck
// Main spectrum slider + dormancy sub-slider + quantum slider for homepage
// noUiSlider is loaded via CDN; declare types loosely

declare const noUiSlider: any;

interface SupplyData {
  provably_lost_sats: string;
  probably_lost_sats: string;
  all_utxos_sats: string;
  quantum_total_sats: string;
  dormancy_curve: Array<{ years: number; total_sats: string }>;
  current_block: number;
}

declare const window: Window & {
  SUPPLY_DATA: SupplyData;
  noUiSlider: any;
};

// Load noUiSlider from CDN script tag
async function loadNoUiSlider(): Promise<any> {
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/nouislider@15.7.1/dist/nouislider.min.js';
    script.onload = () => resolve((window as any).noUiSlider);
    document.head.appendChild(script);
  });
}

const STOPS = [0, 25, 50, 75, 100];
const STOP_LABELS = ['Everything', 'Dormant', 'Probably Lost', 'Provably Lost', 'Nothing'];

function satsToBtc(sats: bigint, decimals = 2): string {
  const btc = Number(sats) / 1e8;
  return btc.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function updateHeroDisplay(outOfCirculationSats: bigint, label: string): void {
  const heroDisplay = document.getElementById('hero-btc-display');
  const heroLabel = document.getElementById('hero-label');
  if (heroDisplay) heroDisplay.textContent = satsToBtc(outOfCirculationSats) + ' BTC';
  if (heroLabel) heroLabel.textContent = label + ' out of circulation';
}

function updateSpectrumDisplay(
  sats: bigint,
  utxos: string,
  label: string,
  allUtxos: bigint
): void {
  const el = document.getElementById('spectrum-sats');
  const descEl = document.getElementById('spectrum-desc');
  const utxoEl = document.getElementById('spectrum-utxos');
  const effectiveEl = document.getElementById('spectrum-effective');

  if (el) el.textContent = satsToBtc(sats) + ' BTC';
  if (descEl) descEl.textContent = label;
  if (utxoEl) utxoEl.textContent = parseInt(utxos).toLocaleString();
  const effective = allUtxos - sats;
  if (effectiveEl) effectiveEl.textContent = satsToBtc(effective > 0n ? effective : 0n);
}

async function main() {
  const data = (window as any).SUPPLY_DATA as SupplyData;
  if (!data) return;

  const noUi = await loadNoUiSlider();

  const provablyLost = BigInt(data.provably_lost_sats);
  const probablyLost = BigInt(data.probably_lost_sats);
  const allUtxos = BigInt(data.all_utxos_sats);

  // Pre-computed values for the 5 stops
  const stopValues: bigint[] = [
    allUtxos,       // 0: Everything
    0n,             // 25: Dormant (will be filled from curve)
    probablyLost,   // 50: Probably Lost
    provablyLost,   // 75: Provably Lost (DEFAULT)
    0n,             // 100: Nothing
  ];

  // Dormancy curve (for interpolation)
  const dormancyCurve = data.dormancy_curve || [];

  // ---- Spectrum Slider ----
  const sliderEl = document.getElementById('spectrum-slider');
  if (!sliderEl) return;

  const slider = noUi.create(sliderEl, {
    start: [75],
    snap: true,
    range: {
      min: 0,
      '25%': 25,
      '50%': 50,
      '75%': 75,
      max: 100,
    },
    pips: {
      mode: 'positions',
      values: [0, 25, 50, 75, 100],
      density: 5,
      format: {
        to: (val: number) => STOP_LABELS[STOPS.indexOf(val)] ?? '',
      }
    }
  });

  // ---- Dormancy Sub-slider ----
  const dormancySection = document.getElementById('dormancy-section');
  const dormancySliderEl = document.getElementById('dormancy-slider');
  let dormancySlider: any = null;
  let currentDormancyYears = 5;

  if (dormancySliderEl) {
    dormancySlider = noUi.create(dormancySliderEl, {
      start: [currentDormancyYears],
      snap: true,
      range: {
        min: 1,
        '14%': 3,
        '28%': 5,
        '42%': 7,
        '57%': 10,
        '71%': 15,
        max: 20,
      },
    });

    dormancySlider.on('update', (values: string[]) => {
      const years = Math.round(parseFloat(values[0]));
      currentDormancyYears = years;
      const label = document.getElementById('dormancy-label');
      if (label) label.textContent = `${years} years dormant`;

      // Find matching curve point
      const curve = dormancyCurve.find((c: any) => c.years === years);
      if (curve) {
        const dormantSats = BigInt(curve.total_sats);
        stopValues[1] = dormantSats;
        if (Math.round(parseFloat((slider.get() as string))) === 25) {
          updateSpectrumDisplay(dormantSats, curve.utxo_count || '0', `dormant ≥${years}y`, allUtxos);
          updateHeroDisplay(dormantSats, `dormant ≥${years}y`);
        }
      }
    });
  }

  // Handle spectrum slider changes
  slider.on('update', (values: string[]) => {
    const pos = Math.round(parseFloat(values[0]));
    const stopIdx = STOPS.indexOf(pos);

    // Show/hide dormancy sub-slider
    if (dormancySection) {
      dormancySection.style.display = pos === 25 ? 'block' : 'none';
    }

    const label = STOP_LABELS[stopIdx] ?? '';

    if (stopIdx >= 0 && pos !== 25) {
      const sats = stopValues[stopIdx];
      updateSpectrumDisplay(sats, '—', label, allUtxos);
      updateHeroDisplay(sats, label);
    } else if (pos === 25) {
      const curve = dormancyCurve.find((c: any) => c.years === currentDormancyYears);
      const dormantSats = curve ? BigInt(curve.total_sats) : 0n;
      updateSpectrumDisplay(dormantSats, '—', `dormant ≥${currentDormancyYears}y`, allUtxos);
      updateHeroDisplay(dormantSats, `dormant ≥${currentDormancyYears}y`);
    }
  });

  // ---- Quantum Slider (homepage collapsible) ----
  const quantumSliderEl = document.getElementById('quantum-slider');
  const quantumTotal = BigInt(data.quantum_total_sats);

  if (quantumSliderEl && quantumTotal > 0n) {
    const qSlider = noUi.create(quantumSliderEl, {
      start: [0],
      range: { min: 0, max: Number(quantumTotal) / 1e8 },
      tooltips: {
        to: (val: number) => val.toFixed(2) + ' BTC',
      }
    });

    const qLabel = document.getElementById('quantum-label');
    const qMax = document.getElementById('quantum-max-label');
    if (qMax) qMax.textContent = satsToBtc(quantumTotal) + ' BTC total';

    qSlider.on('update', (values: string[]) => {
      const btc = parseFloat(values[0]);
      const sats = BigInt(Math.round(btc * 1e8));
      if (qLabel) qLabel.textContent = satsToBtc(sats) + ' BTC';

      const qSatsEl = document.getElementById('quantum-sats');
      const qEffEl = document.getElementById('quantum-effective');
      if (qSatsEl) qSatsEl.textContent = satsToBtc(sats);
      if (qEffEl) qEffEl.textContent = satsToBtc(allUtxos > sats ? allUtxos - sats : 0n);
    });
  }

  // ---- SSE live updates ----
  const sseSource = new EventSource('/api/v1/events');
  sseSource.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'block') {
        const blockEl = document.getElementById('hero-block');
        const timeEl = document.getElementById('hero-time');
        if (blockEl) blockEl.textContent = msg.block_number;
        if (timeEl) timeEl.textContent = 'just now';
      }
    } catch {}
  };

  // Live time display
  const lastBlockTime = new Date();
  setInterval(() => {
    const diff = Math.round((Date.now() - lastBlockTime.getTime()) / 1000);
    const timeEl = document.getElementById('hero-time');
    if (timeEl) {
      if (diff < 60) timeEl.textContent = `${diff}s ago`;
      else timeEl.textContent = `${Math.round(diff / 60)}m ago`;
    }
  }, 10000);

  // Initial display at Provably Lost (stop 75)
  updateSpectrumDisplay(provablyLost, '—', 'Provably Lost', allUtxos);
  updateHeroDisplay(provablyLost, 'Provably Lost');
}

document.addEventListener('DOMContentLoaded', main);
