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
import { classifyNumsBurn } from './proposals-018.js';

export type RuleId = '000'|'001'|'003'|'004'|'005'|'006'|'007'|'008'|'009'|'010'|'011'|'012'|'013'|'015'|'016'|'018';
export type LossBucket = 0 | 1 | 2 | 4;

const PROVABLY_LOST = new Set(['000','001','003','004','005','006','007','008','009','010','011']);

export function computeBucket(rules: RuleId[]): LossBucket {
  if (rules.some(r => PROVABLY_LOST.has(r))) return 1;
  // 018 (NUMS-key burns) sits with the probable burns: same assumption class,
  // and landing in bucket 2 keeps keyless outputs out of the quantum lens.
  if (rules.some(r => r === '012' || r === '013' || r === '018')) return 2;
  if (rules.includes('015')) return 4;
  return 0;
}

export function classifyOutput(ctx: ClassifierInput): { rules: RuleId[], bucket: LossBucket } {
  // A zero-value output destroys nothing, so no loss rule can apply to it —
  // Proposal 004 says as much ("UTXOs with a positive value"), and the same
  // holds for every other rule: you cannot lose supply that was never there.
  // Without this, ~238M zero-value OP_RETURN data carriers counted as
  // provably lost, each contributing 0 sats but inflating every loss count.
  if (ctx.value_sats === 0n) return { rules: [], bucket: 0 };

  const classifiers: Array<(c: ClassifierInput) => RuleId | null> = [
    classifyGenesisBlock, classifyDuplicateCoinbase, classifyMtGoxScript,
    classifyOpReturn, classifyOpVerifAbort, classifyOffCurvePk,
    classifyMultisigOffCurve, classifyTaprootOffCurve, classifySegwitWrongLength,
    classifyWrongHashPush, classifyInvalidPkEncoding,
    classifyKnownBurnAddress, classifyOpTrueACS, classifyP2PKQuantum,
    classifyNumsBurn
  ];
  const rules = classifiers.map(fn => fn(ctx)).filter((r): r is RuleId => r !== null);
  return { rules, bucket: computeBucket(rules) };
}
