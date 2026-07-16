// Linear interpolation over an ascending table of [x, y] pairs
// (same walk-to-bracketing-segment approach as the design prototype).
export function interp(tbl: [number, number][], x: number): number {
  if (!tbl.length) return 0;
  if (x <= tbl[0][0]) return tbl[0][1];
  if (x >= tbl[tbl.length - 1][0]) return tbl[tbl.length - 1][1];
  let i = 1;
  while (i < tbl.length - 1 && tbl[i][0] < x) i++;
  const [x0, y0] = tbl[i - 1];
  const [x1, y1] = tbl[i];
  if (x1 === x0) return y1;
  return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
}
