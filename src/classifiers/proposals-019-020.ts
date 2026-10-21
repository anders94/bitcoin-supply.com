import { ClassifierInput, parseMultisigScript } from './proposals-000-011.js';
import { isValidPubkey, isXOnlyOnCurve, P2TR_RE } from './exposure.js';

// Proposal 019 - Taproot outputs: the output key is a curve point in the
// scriptPubKey, so a quantum attacker can take its discrete log and key-path
// spend regardless of any script tree. Off-curve keys are Proposal 007.
export function classifyTaprootKey(ctx: ClassifierInput): '019' | null {
  const m = P2TR_RE.exec(ctx.script_hex.toLowerCase());
  if (m && isXOnlyOnCurve(m[1])) return '019';
  return null;
}

// Proposal 020 - Bare multisig: every key is in the output script. Needs at
// least M on-curve keys to be spendable at all (fewer is Proposal 006).
export function classifyBareMultisig(ctx: ClassifierInput): '020' | null {
  const ms = parseMultisigScript(ctx.script_hex.toLowerCase());
  if (ms && ms.pubkeys.filter(isValidPubkey).length >= ms.m) return '020';
  return null;
}
