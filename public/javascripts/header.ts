// Live tip in the site header: "905,214 · 12s". Seeded from SSR data
// attributes, updated by SSE block events, re-rendered every 10s.

const tipEl = document.getElementById('tip');
const textEl = document.getElementById('tip-text');

if (tipEl && textEl) {
  let height = Number(tipEl.dataset.tipHeight || 0);
  let tipTs = Date.parse(tipEl.dataset.tipTs || '') || Date.now();

  const renderTip = () => {
    const s = Math.max(0, Math.floor((Date.now() - tipTs) / 1000));
    const rel = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
    textEl.textContent = `${height.toLocaleString('en-US')} · ${rel}`;
  };

  renderTip();
  setInterval(renderTip, 10_000);

  const es = new EventSource('/api/v1/events');
  es.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'block') {
        height = Number(d.block_number);
        if (d.block_timestamp) tipTs = Date.parse(d.block_timestamp);
        renderTip();
      }
    } catch { /* ignore malformed events */ }
  };
}
