import { RULE_TITLES, RULE_CHIP_LABELS, ruleCategory } from './breakdown.js';
import { btc8 } from './format.js';

// Turns the terse database encodings (loss_bucket 2, loss_rules ['012']) into
// self-describing JSON for the API, so a consumer never has to know that "012"
// means a burn address or that bucket 2 is "probably lost". The HTML pages get
// this context from the surrounding page; JSON callers get it inline.

// loss_bucket is the coarse classification. 4 (quantum) is not a loss — it's an
// independent lens (a spendable output whose pubkey is exposed on-chain).
const BUCKET_LABELS: Record<number, string> = {
  0: 'active',
  1: 'provably_lost',
  2: 'probably_lost',
  4: 'quantum_vulnerable',
};

export function bucketLabel(bucket: number): string {
  return BUCKET_LABELS[bucket] ?? 'unknown';
}

export interface RuleDescription {
  code: string;
  label: string;
  category: string;
}

export function describeRules(codes: string[] | null | undefined): RuleDescription[] {
  return (codes ?? []).map(code => ({
    code,
    label: RULE_TITLES[code] ?? RULE_CHIP_LABELS[code] ?? code,
    category: ruleCategory(code),
  }));
}

// Every BTC figure in the API is exposed as an exact string of sats plus its
// full 8-decimal BTC rendering. Sats stay strings because a JSON number can't
// safely round-trip large satoshi values, and btc8 is the same exact formatter
// the rest of the site uses.
export function money(sats: string | bigint | number): { sats: string; btc: string } {
  const s = BigInt(sats);
  return { sats: s.toString(), btc: btc8(s) };
}
