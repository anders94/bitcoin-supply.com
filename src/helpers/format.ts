export function satsToBtc(sats: bigint): string {
  const abs = sats < 0n ? -sats : sats;
  const sign = sats < 0n ? '-' : '';
  const whole = abs / 100_000_000n;
  const frac = (abs % 100_000_000n).toString().padStart(8, '0');
  return `${sign}${whole}.${frac}`;
}

export function formatBtc(sats: bigint, decimals = 2): string {
  const btc = Number(sats) / 1e8;
  return btc.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
