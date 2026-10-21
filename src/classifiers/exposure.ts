// Public-key exposure: which outputs carry a key in the script itself, and
// which spends reveal a key for whatever is left at the address.
//
// Shared by the ETL (block-processor) and the one-off backfill so the two can
// never disagree about what counts as exposed.

import { isOnSecp256k1Curve, parseMultisigScript, SECP256K1_P, modpow } from './proposals-000-011.js';

// How an address's key(s) became visible. Mirrors address_info.exposure_kind.
export type ExposureKind = 'p2pk' | 'p2tr' | 'p2ms' | 'pkh' | 'script' | 'script-mixed';

export interface Exposure {
  kind: ExposureKind;
  // Hex keys an attacker would need to break: 33/65-byte keys, or the 32-byte
  // x-only output key for taproot. Stored comma-joined in pubkey_hex.
  keys: string[];
}

// Rule attached to a UTXO flagged because its address's keys are known.
export function exposureRule(kind: ExposureKind): '016' | '021' {
  return kind === 'script' || kind === 'script-mixed' ? '021' : '016';
}

// ---------------------------------------------------------------------------
// Script parsing
// ---------------------------------------------------------------------------

// OP_RIPEMD160, OP_SHA1, OP_SHA256, OP_HASH160, OP_HASH256: a script using any
// of these on stack input has at least one preimage condition.
const HASH_OPCODES = new Set([0xa6, 0xa7, 0xa8, 0xa9, 0xaa]);

interface ParsedScript {
  pushes: string[];   // data pushes (hex), numeric pushes included as ''
  opcodes: number[];  // every non-push opcode in order
}

// Split a script into data pushes and non-push opcodes. Returns null when the
// script is malformed (push runs past the end), which real spends never are.
export function parseScript(hex: string): ParsedScript | null {
  const pushes: string[] = [];
  const opcodes: number[] = [];
  let pos = 0;
  const n = hex.length;
  while (pos + 1 < n) {
    const op = parseInt(hex.slice(pos, pos + 2), 16);
    pos += 2;
    let len = -1;
    if (op === 0x00) { pushes.push(''); continue; }                 // OP_0
    if (op >= 0x01 && op <= 0x4b) len = op;
    else if (op === 0x4c) { len = parseInt(hex.slice(pos, pos + 2), 16); pos += 2; }
    else if (op === 0x4d) {
      len = parseInt(hex.slice(pos, pos + 2), 16) + parseInt(hex.slice(pos + 2, pos + 4), 16) * 256;
      pos += 4;
    } else if (op === 0x4e) {
      len = 0;
      for (let i = 3; i >= 0; i--) len = len * 256 + parseInt(hex.slice(pos + i * 2, pos + i * 2 + 2), 16);
      pos += 8;
    } else if (op === 0x4f || (op >= 0x51 && op <= 0x60)) { pushes.push(''); continue; } // OP_1NEGATE, OP_1..16
    if (len >= 0) {
      if (pos + len * 2 > n || Number.isNaN(len)) return null;
      pushes.push(hex.slice(pos, pos + len * 2));
      pos += len * 2;
    } else {
      opcodes.push(op);
    }
  }
  return pos === n ? { pushes, opcodes } : null;
}

export function isValidPubkey(hex: string): boolean {
  if (hex.length === 66) return (hex.startsWith('02') || hex.startsWith('03')) && isOnSecp256k1Curve(hex);
  if (hex.length === 130) return hex.startsWith('04') && isOnSecp256k1Curve(hex);
  return false;
}

// x-only (BIP-340) key: a valid x coordinate has a square y^2 = x^3 + 7.
export function isXOnlyOnCurve(xHex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(xHex)) return false;
  const p = SECP256K1_P;
  const x = BigInt('0x' + xHex);
  if (x === 0n || x >= p) return false;
  const rhs = ((x * x % p) * x + 7n) % p;
  return modpow(rhs, (p - 1n) / 2n, p) === 1n;
}

function uniq(keys: string[]): string[] {
  return [...new Set(keys)];
}

// ---------------------------------------------------------------------------
// Keys visible in the output script (exposed from creation)
// ---------------------------------------------------------------------------

export const P2TR_RE = /^5120([0-9a-f]{64})$/;

// P2PK (015), P2TR (019) and bare multisig (020). Only on-curve keys count: an
// off-curve "key" has no private key to derive, and those outputs are already
// provably lost under 005 / 006 / 007.
export function exposedKeysInOutput(scriptHex: string): Exposure | null {
  const hex = scriptHex.toLowerCase();

  if (hex.length === 134 && hex.startsWith('41') && hex.endsWith('ac')) {
    const pk = hex.slice(2, 132);
    return isValidPubkey(pk) ? { kind: 'p2pk', keys: [pk] } : null;
  }
  if (hex.length === 70 && hex.startsWith('21') && hex.endsWith('ac')) {
    const pk = hex.slice(2, 68);
    return isValidPubkey(pk) ? { kind: 'p2pk', keys: [pk] } : null;
  }

  const tr = P2TR_RE.exec(hex);
  if (tr) return isXOnlyOnCurve(tr[1]) ? { kind: 'p2tr', keys: [tr[1]] } : null;

  const ms = parseMultisigScript(hex);
  if (ms) {
    const keys = uniq(ms.pubkeys.filter(isValidPubkey));
    // Fewer than M real keys is Proposal 006 (unspendable), not exposure.
    return keys.length >= ms.m ? { kind: 'p2ms', keys } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Keys revealed by a spend (exposed from the spend onward)
// ---------------------------------------------------------------------------

const P2WPKH_PROGRAM_RE = /^0014[0-9a-f]{40}$/;
const P2WSH_PROGRAM_RE = /^0020[0-9a-f]{64}$/;

// A revealed redeem/witness script: every on-curve key push in it is now
// public. If the script also hashes stack input it has a preimage condition
// somewhere (HTLC, atomic swap); keys are still exposed, but we label it so
// the caveat is visible downstream.
export function keysInRevealedScript(scriptHex: string | undefined): Exposure | null {
  if (!scriptHex) return null;
  const parsed = parseScript(scriptHex.toLowerCase());
  if (!parsed) return null;
  const keys = uniq(parsed.pushes.filter(isValidPubkey));
  if (keys.length === 0) return null;
  const mixed = parsed.opcodes.some(op => HASH_OPCODES.has(op));
  return { kind: mixed ? 'script-mixed' : 'script', keys };
}

const last = <T>(arr: T[]): T | undefined => (arr.length ? arr[arr.length - 1] : undefined);

// Given a decoded input (getblock verbosity 3: prevout + scriptSig.hex +
// txinwitness), return what it reveals about the previous output's address.
//
//   P2PKH            scriptSig: <sig> <pubkey>
//   P2WPKH           witness:   [sig, pubkey]
//   P2SH-P2WPKH      scriptSig: <0014{20}>            witness: [sig, pubkey]
//   P2SH             scriptSig: … <redeemScript>
//   P2WSH            witness:   [… , witnessScript]
//   P2SH-P2WSH       scriptSig: <0020{32}>            witness: [… , witnessScript]
//
// P2PK, P2TR and P2MS prevouts reveal nothing new (the key was in the output),
// and nonstandard prevouts are ignored.
export function revealedKeysFromInput(vin: any): Exposure | null {
  const type: string | undefined = vin?.prevout?.scriptPubKey?.type;
  const sigHex: string | undefined = vin?.scriptSig?.hex;
  const witness: string[] = Array.isArray(vin?.txinwitness) ? vin.txinwitness : [];
  const sigPushes = sigHex ? (parseScript(sigHex.toLowerCase())?.pushes ?? []) : [];

  const pkh = (pk: string | undefined): Exposure | null =>
    pk && isValidPubkey(pk.toLowerCase()) ? { kind: 'pkh', keys: [pk.toLowerCase()] } : null;

  switch (type) {
    case 'pubkeyhash':
      return pkh(last(sigPushes));
    case 'witness_v0_keyhash':
      return witness.length === 2 ? pkh(witness[1]) : null;
    case 'scripthash': {
      const redeem = last(sigPushes);
      if (!redeem) return null;
      if (P2WPKH_PROGRAM_RE.test(redeem)) return witness.length === 2 ? pkh(witness[1]) : null;
      if (P2WSH_PROGRAM_RE.test(redeem)) return keysInRevealedScript(last(witness));
      return keysInRevealedScript(redeem);
    }
    case 'witness_v0_scripthash':
      return keysInRevealedScript(last(witness));
    case undefined: {
      // No prevout decoding available: fall back to the two unambiguous shapes.
      const fromSig = pkh(last(sigPushes));
      if (fromSig) return fromSig;
      return witness.length === 2 ? pkh(witness[1]) : null;
    }
    default:
      return null;
  }
}
