import { ClassifierInput } from './proposals-000-011.js';

export function classifyKnownBurnAddress(ctx: ClassifierInput): '012' | null {
  if (ctx.address && ctx.knownBurnAddresses.has(ctx.address)) return '012';
  return null;
}

export function classifyOpTrueACS(ctx: ClassifierInput): '013' | null {
  // OP_TRUE (0x51) outputs that are >3 years old
  if (ctx.script_hex === '51') {
    const threeYearsAgo = new Date();
    threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
    if (ctx.block_timestamp < threeYearsAgo) return '013';
  }
  return null;
}
