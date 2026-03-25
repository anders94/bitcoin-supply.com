// @ts-nocheck
// Quantum page slider logic

declare const window: Window & {
  QUANTUM_DATA: {
    quantum_all_sats: string;
    quantum_p2pk_sats: string;
  };
};

async function loadNoUiSlider(): Promise<any> {
  return new Promise((resolve) => {
    if ((window as any).noUiSlider) {
      resolve((window as any).noUiSlider);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/nouislider@15.7.1/dist/nouislider.min.js';
    script.onload = () => resolve((window as any).noUiSlider);
    document.head.appendChild(script);
  });
}

function satsToBtc(sats: bigint, decimals = 2): string {
  const btc = Number(sats) / 1e8;
  return btc.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

interface QuantumBreakpoint {
  threshold_sats: string;
  utxo_count: string;
  total_sats: string;
  address_count: string;
  min_value_sats: string;
}

let quantumCurve: QuantumBreakpoint[] = [];

async function fetchQuantumCurve(): Promise<void> {
  try {
    const resp = await fetch('/api/v1/quantum-curve');
    const data = await resp.json();
    quantumCurve = data.breakpoints || [];
  } catch {}
}

function interpolateCurve(targetSats: bigint): { utxo_count: number; total_sats: bigint } {
  if (!quantumCurve.length) return { utxo_count: 0, total_sats: 0n };

  // Find the closest breakpoint
  for (let i = 0; i < quantumCurve.length; i++) {
    const bp = quantumCurve[i];
    if (BigInt(bp.threshold_sats) >= targetSats) {
      return {
        utxo_count: parseInt(bp.utxo_count),
        total_sats: BigInt(bp.total_sats),
      };
    }
  }

  // Use max
  const last = quantumCurve[quantumCurve.length - 1];
  return {
    utxo_count: parseInt(last.utxo_count),
    total_sats: BigInt(last.total_sats),
  };
}

async function main() {
  const data = (window as any).QUANTUM_DATA;
  if (!data) return;

  await fetchQuantumCurve();

  const noUi = await loadNoUiSlider();
  const quantumAll = BigInt(data.quantum_all_sats);
  if (quantumAll === 0n) return;

  const sliderEl = document.getElementById('quantum-page-slider');
  if (!sliderEl) return;

  const maxBtc = Number(quantumAll) / 1e8;

  const slider = noUi.create(sliderEl, {
    start: [0],
    range: { min: 0, max: maxBtc },
    tooltips: {
      to: (val: number) => val.toFixed(2) + ' BTC',
    },
    step: maxBtc / 1000,
  });

  const stolenEl = document.getElementById('qp-stolen');
  const keysEl = document.getElementById('qp-keys');
  const effectiveEl = document.getElementById('qp-effective');
  const labelEl = document.getElementById('q-label-center');

  // All UTXOs total for effective supply calc
  let allUtxosSats = quantumAll;
  try {
    const statsResp = await fetch('/api/v1/stats');
    const stats = await statsResp.json();
    allUtxosSats = BigInt(stats.all_utxos_sats || stats.circulating_supply_sats);
  } catch {}

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  slider.on('update', (values: string[]) => {
    const btc = parseFloat(values[0]);
    const sats = BigInt(Math.round(btc * 1e8));

    // Instant interpolation from curve
    const { utxo_count, total_sats } = interpolateCurve(sats);

    if (stolenEl) stolenEl.textContent = satsToBtc(sats);
    if (keysEl) keysEl.textContent = utxo_count.toLocaleString();
    if (effectiveEl) effectiveEl.textContent = satsToBtc(allUtxosSats > sats ? allUtxosSats - sats : 0n);
    if (labelEl) labelEl.textContent = satsToBtc(sats) + ' BTC';
  });
}

document.addEventListener('DOMContentLoaded', main);
