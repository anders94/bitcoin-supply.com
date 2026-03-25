import { ClassifierInput } from './proposals-000-011.js';
export type { ClassifierInput };
import {
  classifyGenesisBlock, classifyDuplicateCoinbase, classifyMtGoxScript,
  classifyOpReturn, classifyOpVerifAbort, classifyOffCurvePk,
  classifyMultisigOffCurve, classifyTaprootOffCurve, classifySegwitWrongLength,
  classifyWrongHashPush, classifyInvalidPkEncoding
} from './proposals-000-011.js';
import { classifyKnownBurnAddress, classifyOpTrueACS } from './proposals-012-013.js';
import { classifyP2PKQuantum } from './proposals-015.js';

export type RuleId = '000'|'001'|'003'|'004'|'005'|'006'|'007'|'008'|'009'|'010'|'011'|'012'|'013'|'015'|'016';
export type LossBucket = 0 | 1 | 2 | 4;

const PROVABLY_LOST = new Set(['000','001','003','004','005','006','007','008','009','010','011']);

export function computeBucket(rules: RuleId[]): LossBucket {
  if (rules.some(r => PROVABLY_LOST.has(r))) return 1;
  if (rules.some(r => r === '012' || r === '013')) return 2;
  if (rules.includes('015')) return 4;
  return 0;
}

export function classifyOutput(ctx: ClassifierInput): { rules: RuleId[], bucket: LossBucket } {
  const classifiers: Array<(c: ClassifierInput) => RuleId | null> = [
    classifyGenesisBlock, classifyDuplicateCoinbase, classifyMtGoxScript,
    classifyOpReturn, classifyOpVerifAbort, classifyOffCurvePk,
    classifyMultisigOffCurve, classifyTaprootOffCurve, classifySegwitWrongLength,
    classifyWrongHashPush, classifyInvalidPkEncoding,
    classifyKnownBurnAddress, classifyOpTrueACS, classifyP2PKQuantum
  ];
  const rules = classifiers.map(fn => fn(ctx)).filter((r): r is RuleId => r !== null);
  return { rules, bucket: computeBucket(rules) };
}
