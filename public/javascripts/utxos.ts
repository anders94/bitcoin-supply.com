// /utxos unit toggle: swap the age x value matrix between BTC HELD and
// UTXO COUNT. Both variants are pre-rendered server-side into __UTXOS__.

interface Cell { v: string; bg: string; fg: string; }

declare global {
  interface Window { __UTXOS__: { btc: Cell[][]; count: Cell[][] }; }
}

const D = window.__UTXOS__;

if (D) {
  const cells = document.querySelectorAll<HTMLElement>('#matrix .cell');
  const unitLabel = document.getElementById('matrix-unit');

  const setUnit = (unit: 'btc' | 'count') => {
    const flat = D[unit].flat();
    cells.forEach((el, i) => {
      const c = flat[i];
      if (!c) return;
      el.textContent = c.v;
      el.style.background = c.bg;
      el.style.color = c.fg;
    });
    if (unitLabel) unitLabel.textContent = unit === 'btc' ? 'BTC HELD' : 'UTXO COUNT';
    document.querySelectorAll<HTMLElement>('.chip-btn[data-unit]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.unit === unit);
    });
  };

  document.querySelectorAll<HTMLElement>('.chip-btn[data-unit]').forEach(btn => {
    btn.addEventListener('click', () => setUnit(btn.dataset.unit as 'btc' | 'count'));
  });
}
export {};
