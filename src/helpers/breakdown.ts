// Shared rule metadata: chip labels, homepage breakdown grouping, categories.
// Used by the ETL snapshot job (top-loss labels) and the page routes.

export const RULE_CHIP_LABELS: Record<string, string> = {
  '000': 'GENESIS',
  '001': 'DUP-COINBASE',
  '002': 'MINER-LOSS',
  '003': 'MTGOX-SCRIPT',
  '004': 'OP_RETURN',
  '005': 'OFF-CURVE',
  '006': 'MULTISIG-OFF',
  '007': 'TAPROOT-KEY',
  '008': 'SEGWIT-LEN',
  '009': 'BAD-HASH-LEN',
  '010': 'BAD-PUBKEY',
  '011': 'OP_VERIF',
  '012': 'BURN',
  '013': 'OP_TRUE',
  '015': 'P2PK',
  '016': 'EXPOSED-PKH',
};

// Long-form titles for the top-losses list.
export const RULE_TITLES: Record<string, string> = {
  '000': 'Block 0 coinbase',
  '001': 'Duplicate coinbase txids',
  '003': 'Mt. Gox error script',
  '004': 'OP_RETURN output',
  '005': 'Off-curve P2PK key',
  '006': 'Multisig with off-curve keys',
  '007': 'Taproot invalid x-only key',
  '008': 'SegWit wrong program length',
  '009': 'Wrong length hash push',
  '010': 'P2PK invalid key encoding',
  '011': 'OP_VERIF abort opcode',
  '012': 'Burn address',
  '013': 'OP_TRUE anyone-can-spend',
};

export interface BreakdownGroup {
  rules: string[];
  label: string;
}

// Homepage breakdown table rows (rule-grouped, per the design).
export const BREAKDOWN_GROUPS: { provable: BreakdownGroup[]; probable: BreakdownGroup[] } = {
  provable: [
    { rules: ['000'], label: 'Block 0 coinbase' },
    { rules: ['001'], label: 'Duplicate coinbase txids' },
    { rules: ['003'], label: 'Mt. Gox error script' },
    { rules: ['004'], label: 'OP_RETURN outputs' },
    { rules: ['005', '006', '007', '008', '009', '010', '011'], label: 'Invalid scripts & off-curve keys' },
  ],
  probable: [
    { rules: ['012'], label: 'Known burn addresses' },
    { rules: ['013'], label: 'OP_TRUE dormant ≥ 3y' },
  ],
};

const PROVABLE_RULES = new Set(['000', '001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011']);
const PROBABLE_RULES = new Set(['012', '013']);
const QUANTUM_RULES = new Set(['015', '016']);

export type RuleCategory = 'provable' | 'probable' | 'quantum' | 'other';

export function ruleCategory(rule: string): RuleCategory {
  if (PROVABLE_RULES.has(rule)) return 'provable';
  if (PROBABLE_RULES.has(rule)) return 'probable';
  if (QUANTUM_RULES.has(rule)) return 'quantum';
  return 'other';
}

// Proposal front-matter Category value -> chip modifier class.
export const CATEGORY_CHIP_CLASS: Record<string, string> = {
  'PROVABLE': 'chip--red',
  'PROBABLE': 'chip--amber',
  'QUANTUM': 'chip--purple',
  'DORMANT': 'chip--gray',
  'RESEARCH': 'chip--gray',
};

// Escape-safe JSON for inline <script> SSR embedding.
export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
