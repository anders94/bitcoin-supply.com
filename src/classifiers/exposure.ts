// Public-key exposure: which outputs carry a key in the script itself, and
// which spends reveal a key for whatever is left at the address.
//
// Shared by the ETL (block-processor) and the one-off backfill so the two can
// never disagree about what counts as exposed.

import { createHash } from 'node:crypto';
import { isOnSecp256k1Curve, parseMultisigScript, SECP256K1_P, modpow } from './proposals-000-011.js';

// How an address's key(s) became visible. Mirrors address_info.exposure_kind.
export type ExposureKind = 'p2pk' | 'p2tr' | 'p2ms' | 'pkh' | 'script' | 'script-mixed' | 'reuse';

export interface Exposure {
  kind: ExposureKind;
  // Hex keys an attacker would need to break: 33/65-byte keys, or the 32-byte
  // x-only output key for taproot. Stored comma-joined in pubkey_hex.
  keys: string[];
}

export type ExposureRule = '016' | '021' | '022';

// Rule attached to a UTXO flagged because its address's keys are known.
export function exposureRule(kind: ExposureKind): ExposureRule {
  if (kind === 'reuse') return '022';
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
  if (hex.length === 130) return isOnSecp256k1Curve(hex);  // 04, or hybrid 06 / 07
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
    const valid = ms.pubkeys.filter(isValidPubkey);
    // Fewer than M real keys is Proposal 006 (unspendable), not exposure.
    // Counted before de-duplicating: a 2-of-2 listing one key twice is
    // spendable with two signatures from that key.
    return valid.length >= ms.m ? { kind: 'p2ms', keys: uniq(valid) } : null;
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

// ---------------------------------------------------------------------------
// Sibling addresses of a known key (Proposal 022)
// ---------------------------------------------------------------------------

const sha256 = (b: Buffer): Buffer => createHash('sha256').update(b).digest();
export const hash160 = (b: Buffer): Buffer => createHash('ripemd160').update(sha256(b)).digest();

export interface KeyHashes {
  key: string;      // the encoding hashed (hex)
  h160: Buffer;     // P2PKH / P2WPKH program
  p2shH160: Buffer; // P2SH-P2WPKH: HASH160(0014 <h160>)
}

const P2WPKH_PREFIX = Buffer.from('0014', 'hex');

// The encodings of a key that single-key address types commit to. An
// uncompressed key also yields its compressed form (the parity of y is right
// there); the reverse needs a modular square root, and no wallet pays the
// uncompressed addresses of a key it uses compressed. A hybrid key (06 / 07)
// yields itself plus both standard forms.
export function keyHashes(keyHex: string): KeyHashes[] {
  const hex = keyHex.toLowerCase();
  const encodings: string[] = [];
  if (hex.length === 130 && (hex.startsWith('04') || hex.startsWith('06') || hex.startsWith('07'))) {
    const odd = parseInt(hex.slice(128, 130), 16) & 1;
    if (!hex.startsWith('04')) encodings.push(hex);
    encodings.push('04' + hex.slice(2), (odd ? '03' : '02') + hex.slice(2, 66));
  } else if (hex.length === 66 && (hex.startsWith('02') || hex.startsWith('03'))) {
    encodings.push(hex);
  }
  return encodings.map(key => {
    const h160 = hash160(Buffer.from(key, 'hex'));
    return { key, h160, p2shH160: hash160(Buffer.concat([P2WPKH_PREFIX, h160])) };
  });
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58check(version: number, payload: Buffer): string {
  const body = Buffer.concat([Buffer.from([version]), payload]);
  const buf = Buffer.concat([body, sha256(sha256(body)).subarray(0, 4)]);
  let n = BigInt('0x' + buf.toString('hex'));
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const byte of buf) { if (byte !== 0) break; s = '1' + s; }
  return s;
}

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

// Segwit v0 address (bech32, BIP-173). v1+ uses bech32m and is not needed here.
export function segwitV0Address(program: Buffer, hrp = 'bc'): string {
  const data = [0];
  let acc = 0, bits = 0;
  for (const byte of program) {
    acc = (acc << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; data.push((acc >> bits) & 31); }
  }
  if (bits) data.push((acc << (5 - bits)) & 31);
  const hrpExpanded = [...hrp].map(c => c.charCodeAt(0) >> 5)
    .concat([0], [...hrp].map(c => c.charCodeAt(0) & 31));
  const mod = bech32Polymod(hrpExpanded.concat(data, [0, 0, 0, 0, 0, 0])) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map(i => (mod >> (5 * (5 - i))) & 31);
  return hrp + '1' + data.concat(checksum).map(i => BECH32[i]).join('');
}

export interface SiblingAddress { address: string; key: string; }

// Every single-key address a key controls: P2PKH, P2WPKH and P2SH-P2WPKH for
// each encoding from keyHashes(). Includes whichever one the key was seen at.
export function siblingAddresses(keyHex: string): SiblingAddress[] {
  return keyHashes(keyHex).flatMap(({ key, h160, p2shH160 }) => [
    { address: base58check(0x00, h160), key },
    { address: segwitV0Address(h160), key },
    { address: base58check(0x05, p2shH160), key },
  ]);
}

// ---------------------------------------------------------------------------
// From an address back to a known key (Proposal 022 at receipt time)
// ---------------------------------------------------------------------------

export type SingleKeyType = 'p2pkh' | 'p2wpkh' | 'p2sh';

// Type and 20-byte payload of a P2PKH / P2SH (base58) or P2WPKH (bech32 v0)
// address, or null for any other kind. Checksums are not verified: every
// match against a payload is confirmed by re-hashing a real key.
export function addressPayload(addr: string): { type: SingleKeyType; payload: Buffer } | null {
  if (addr.startsWith('bc1q')) {
    if (addr.length !== 42) return null;  // P2WSH is 62
    const out: number[] = [];
    let acc = 0, bits = 0;
    for (let i = 4; i < addr.length - 6; i++) {
      const v = BECH32.indexOf(addr[i]);
      if (v < 0) return null;
      acc = (acc << 5) | v; bits += 5;
      if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
    }
    if (out.length !== 20) return null;
    // Re-encoding checks the checksum and padding: a typo must not read as a
    // real (and unexposed) address.
    const payload = Buffer.from(out);
    return segwitV0Address(payload) === addr ? { type: 'p2wpkh', payload } : null;
  }
  if (addr[0] !== '1' && addr[0] !== '3') return null;
  const bytes = new Uint8Array(25);
  for (const ch of addr) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return null;
    for (let i = 24; i >= 0; i--) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    if (carry) return null;  // longer than 25 bytes
  }
  const version = bytes[0];
  if (version !== 0x00 && version !== 0x05) return null;
  // Re-encoding checks the checksum and the leading '1's (each one a zero byte).
  const payload = Buffer.from(bytes.subarray(1, 21));
  if (base58check(version, payload) !== addr) return null;
  return { type: version === 0x00 ? 'p2pkh' : 'p2sh', payload };
}

// Whether a string is a valid mainnet address of any type: base58check P2PKH /
// P2SH, or segwit (bech32 for v0, bech32m for v1+, BIP-173 / BIP-350).
export function isValidAddress(addr: string): boolean {
  if (addr[0] === '1' || addr[0] === '3') return addressPayload(addr) !== null;
  const lower = addr.toLowerCase();
  if ((addr !== lower && addr !== addr.toUpperCase()) || !lower.startsWith('bc1') || lower.length > 90) return false;
  const data = [...lower.slice(3)].map(c => BECH32.indexOf(c));
  if (data.length < 7 || data.some(v => v < 0)) return false;
  const version = data[0];
  if (version > 16) return false;
  // HRP 'bc' expanded: high bits of each char, 0, low bits of each char.
  if (bech32Polymod([3, 3, 0, 2, 3, ...data]) !== (version === 0 ? 1 : 0x2bc830a3)) return false;
  const bits = (data.length - 7) * 5;
  const len = Math.floor(bits / 8);
  if (bits % 8 >= 5) return false;
  if (data[data.length - 7] & ((1 << (bits % 8)) - 1)) return false;  // non-zero padding
  return version === 0 ? len === 20 || len === 32 : len >= 2 && len <= 40;
}

// The P2SH-P2WPKH script hash for a key hash: HASH160(0014 <h160>).
export const p2shWrap = (h160: Buffer): Buffer => hash160(Buffer.concat([P2WPKH_PREFIX, h160]));

// Addresses that share a P2PKH / P2WPKH address's key hash: the other of the
// two, and the P2SH-P2WPKH wrapping. Computable from the address alone, so a
// key revealed at any of them is found by looking them up. (A P2SH address
// cannot be unwrapped, so it has none.)
export function forwardSiblings(addr: string): string[] {
  const a = addressPayload(addr);
  if (!a || a.type === 'p2sh') return [];
  const other = a.type === 'p2pkh' ? segwitV0Address(a.payload) : base58check(0x00, a.payload);
  return [other, base58check(0x05, p2shWrap(a.payload))];
}

// Signed first 8 bytes of a hash: the revealed_key_hashes lookup column.
export const hashPrefix = (h: Buffer): bigint => h.readBigInt64BE(0);

export interface KeyHashEntry { h8: bigint; key: string; }

// Entries for revealed_key_hashes: every sibling hash of `keyHex` that
// forwardSiblings() cannot reach from a sibling address. When the key was
// revealed by spending from a single-key address (`revealedAt`), that
// encoding's key hash is reachable (its P2PKH / P2WPKH / P2SH-P2WPKH siblings
// all forward-resolve to the exposed address), and so is its P2SH wrapping if
// the reveal was the P2SH-P2WPKH address itself. Everything else, i.e. other
// encodings and keys seen in scripts or outputs, needs an entry.
export function reverseIndexEntries(keyHex: string, revealedAt: string | null): KeyHashEntry[] {
  const at = revealedAt ? addressPayload(revealedAt) : null;
  const out: KeyHashEntry[] = [];
  for (const { key, h160, p2shH160 } of keyHashes(keyHex)) {
    const revealedEncoding = at !== null && (at.type === 'p2sh' ? p2shH160 : h160).equals(at.payload);
    if (!revealedEncoding) out.push({ h8: hashPrefix(h160), key });
    if (!(revealedEncoding && at!.type === 'p2sh')) out.push({ h8: hashPrefix(p2shH160), key });
  }
  return out;
}

// Does `keyHex` control `addr` through a single-key template?
export function keyControls(keyHex: string, addr: string): boolean {
  const a = addressPayload(addr);
  if (!a) return false;
  const h = hash160(Buffer.from(keyHex, 'hex'));
  return (a.type === 'p2sh' ? p2shWrap(h) : h).equals(a.payload);
}
