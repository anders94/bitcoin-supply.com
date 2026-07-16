// Client-side formatting. Sats arrive as strings; 8-decimal displays go
// through BigInt so the tail digits are exact (Number/1e8 is lossy there).

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function btcParts(sats: string | bigint): { int: string; dec: string } {
  const v = BigInt(sats);
  const abs = v < 0n ? -v : v;
  const sign = v < 0n ? '-' : '';
  return {
    int: sign + group((abs / 100_000_000n).toString()),
    dec: (abs % 100_000_000n).toString().padStart(8, '0'),
  };
}

export function btc8(sats: string | bigint): string {
  const p = btcParts(sats);
  return `${p.int}.${p.dec}`;
}

export function fmtNum(n: number, decimals: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
