// @ts-nocheck
// Chart.js setup for supply donut and loss breakdown
// Chart.js loaded via CDN

declare const Chart: any;

function satsToBtc(sats: bigint): number {
  return Number(sats) / 1e8;
}

async function initSupplyDonut(): Promise<void> {
  const canvas = document.getElementById('supply-chart') as HTMLCanvasElement;
  if (!canvas) return;

  const data = (window as any).SUPPLY_DATA;
  if (!data) return;

  const allUtxos = BigInt(data.all_utxos_sats || '0');
  const provablyLost = BigInt(data.provably_lost_sats || '0');
  const probablyLost = BigInt(data.probably_lost_sats || '0');
  const maxSupply = 2_100_000_000_000_000n; // 21M BTC in sats

  const circulating = allUtxos - provablyLost;
  const unminedSats = maxSupply > allUtxos ? maxSupply - allUtxos : 0n;
  const probablyOnlyLost = probablyLost - provablyLost;

  new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: ['Circulating', 'Provably Lost', 'Probably Lost', 'Unmined'],
      datasets: [{
        data: [
          satsToBtc(circulating),
          satsToBtc(provablyLost),
          satsToBtc(probablyOnlyLost > 0n ? probablyOnlyLost : 0n),
          satsToBtc(unminedSats),
        ],
        backgroundColor: [
          '#F7931A',
          '#EF4444',
          '#F59E0B',
          '#404040',
        ],
        borderColor: '#1A1A1A',
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#A3A3A3',
            font: { size: 12 },
            padding: 16,
          }
        },
        tooltip: {
          callbacks: {
            label: (ctx: any) => {
              const val = ctx.parsed;
              return ` ${val.toLocaleString('en-US', { maximumFractionDigits: 2 })} BTC`;
            }
          }
        }
      },
      cutout: '65%',
    }
  });
}

async function initLossBreakdown(): Promise<void> {
  // Fetch loss breakdown and update the progress bar
  try {
    const resp = await fetch('/api/v1/loss-breakdown');
    const data: Array<{ rule: string; total_sats: string; utxo_count: string }> = await resp.json();

    const total = data.reduce((sum, r) => sum + BigInt(r.total_sats), 0n);
    const totalEl = document.getElementById('breakdown-total');
    if (totalEl) {
      totalEl.textContent = satsToBtc(total).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' BTC total';
    }

    // Update progress bar fill
    const fillEl = document.getElementById('breakdown-fill');
    const allUtxosData = (window as any).SUPPLY_DATA;
    if (fillEl && allUtxosData) {
      const allUtxos = BigInt(allUtxosData.all_utxos_sats || '0');
      if (allUtxos > 0n) {
        const pct = (Number(total) / Number(allUtxos)) * 100;
        fillEl.style.width = Math.min(pct, 100) + '%';
      }
    }
  } catch {}
}

document.addEventListener('DOMContentLoaded', () => {
  initSupplyDonut();
  initLossBreakdown();
});
