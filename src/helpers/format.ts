// BTC amounts are always displayed at full satoshi precision (btc8/btcParts) —
// rounding to 2dp renders a 1-sat loss as "0.00", which is a lie. btc2 exists
// only for prose summaries (meta descriptions), never for UI figures.

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Exact BTC parts from a sats string: { int: '19,669,499', dec: '55342301' }.
export function btcParts(sats: string | bigint): { int: string; dec: string } {
  const v = BigInt(sats);
  const abs = v < 0n ? -v : v;
  const sign = v < 0n ? '-' : '';
  return {
    int: sign + group((abs / 100_000_000n).toString()),
    dec: (abs % 100_000_000n).toString().padStart(8, '0'),
  };
}

// Exact grouped BTC with all 8 decimals: '2,609.36304319'.
export function btc8(sats: string | bigint): string {
  const p = btcParts(sats);
  return `${p.int}.${p.dec}`;
}

// Grouped BTC with reduced decimals (display-only, safe via Number for 0-2dp).
export function btc2(sats: string | bigint, decimals = 2): string {
  const btc = Number(BigInt(sats)) / 1e8;
  return btc.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function num(n: number | string | bigint): string {
  return Number(n).toLocaleString('en-US');
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 4)}…${hash.slice(-4)}`;
}

export function shortAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function dateUtc(ts: string | Date): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function dateTimeUtc(ts: string | Date): string {
  const d = new Date(ts);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

// Block subsidy in sats at a given height.
export function subsidyAt(blockNumber: number): bigint {
  const halvings = Math.floor(blockNumber / 210_000);
  if (halvings >= 64) return 0n;
  return 5_000_000_000n >> BigInt(halvings);
}
