import { ClassifierInput } from './proposals-000-011.js';

// Proposal 018 - NUMS-key burns
//
// Outputs paying to a documented nothing-up-my-sleeve point in any spendable
// wrapping. The key's construction (e.g. BIP-341's lift_x(SHA256(ser(G)))) is
// public and verifiable, so no private key can exist under standard
// assumptions — the same cryptographic footing as rule 012's burn addresses,
// hence the same Probably Lost bucket. Matching is exact, against the wrappings
// precomputed in nums.ts from the curated nums_keys table.
export function classifyNumsBurn(ctx: ClassifierInput): '018' | null {
  if (ctx.numsMatcher.scriptHexes.has(ctx.script_hex)) return '018';
  if (ctx.address && ctx.numsMatcher.addresses.has(ctx.address)) return '018';
  return null;
}
