import { createHash } from 'crypto';
import { Pool } from 'pg';
import { SECP256K1_P, modpow } from './proposals-000-011.js';

// Proposal 018 support: expand each curated NUMS x-coordinate (nums_keys table)
// into every spendable wrapping it could appear in on-chain, so the classifier
// can match by exact script_hex or address. Derivations run once at ETL startup.
//
// Wrappings per x:
//   script_hex — P2TR output key (5120‖x), compressed P2PK (21 02/03‖x ac),
//                uncompressed P2PK (41 04‖x‖y ac, both y parities)
//   address    — P2PKH of the compressed and uncompressed keys, P2WPKH of the
//                compressed keys (segwit requires compressed keys, so there is
//                no uncompressed P2WPKH form)

export interface NumsMatcher {
  scriptHexes: Set<string>;
  addresses: Set<string>;
}

export const EMPTY_NUMS_MATCHER: NumsMatcher = { scriptHexes: new Set(), addresses: new Set() };

// y² = x³ + 7 over the secp256k1 field; p ≡ 3 (mod 4) so a square root, when it
// exists, is a^((p+1)/4). Returns the even-y root, or null if x is off-curve
// (a NUMS x is on-curve by construction, but don't assume table contents).
function liftX(x: bigint): bigint | null {
  const p = SECP256K1_P;
  const rhs = (((x * x) % p) * x + 7n) % p;
  const y = modpow(rhs, (p + 1n) / 4n, p);
  if ((y * y) % p !== rhs) return null;
  return y % 2n === 0n ? y : p - y;
}

const hex64 = (n: bigint) => n.toString(16).padStart(64, '0');

function sha256(b: Buffer): Buffer { return createHash('sha256').update(b).digest(); }
function hash160(hexStr: string): Buffer {
  return createHash('ripemd160').update(sha256(Buffer.from(hexStr, 'hex'))).digest();
}

function base58check(version: number, payload: Buffer): string {
  const data = Buffer.concat([Buffer.from([version]), payload]);
  const check = sha256(sha256(data)).subarray(0, 4);
  const full = Buffer.concat([data, check]);
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + full.toString('hex'));
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of full) { if (byte === 0) out = '1' + out; else break; }
  return out;
}

// Minimal BIP-173 bech32 encoder for P2WPKH (witness v0, 20-byte program).
function bech32P2wpkh(program: Buffer): string {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const polymod = (values: number[]): number => {
    let chk = 1;
    for (const v of values) {
      const top = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
    }
    return chk;
  };
  const hrp = 'bc';
  const hrpExpanded = [...hrp].map(c => c.charCodeAt(0) >> 5)
    .concat([0], [...hrp].map(c => c.charCodeAt(0) & 31));
  // convert 8-bit program bytes to 5-bit groups
  const words: number[] = [];
  let acc = 0, bits = 0;
  for (const b of program) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; words.push((acc >> bits) & 31); }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  const data = [0].concat(words); // witness version 0
  const pm = polymod(hrpExpanded.concat(data).concat([0, 0, 0, 0, 0, 0])) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) checksum.push((pm >> (5 * (5 - i))) & 31);
  return hrp + '1' + data.concat(checksum).map(v => CHARSET[v]).join('');
}

export function buildNumsMatcher(xCoords: string[]): NumsMatcher {
  const scriptHexes = new Set<string>();
  const addresses = new Set<string>();

  for (const raw of xCoords) {
    const x = raw.toLowerCase().trim();
    if (!/^[0-9a-f]{64}$/.test(x)) continue; // ignore malformed table rows

    // P2TR: the NUMS point used directly (untweaked) as the output key.
    scriptHexes.add('5120' + x);

    // Compressed P2PK, both parities.
    const compressedEven = '02' + x;
    const compressedOdd = '03' + x;
    scriptHexes.add('21' + compressedEven + 'ac');
    scriptHexes.add('21' + compressedOdd + 'ac');

    // Uncompressed P2PK needs y; skip if x is somehow off-curve.
    const yEven = liftX(BigInt('0x' + x));
    if (yEven !== null) {
      const yOdd = SECP256K1_P - yEven;
      const uncompressedEven = '04' + x + hex64(yEven);
      const uncompressedOdd = '04' + x + hex64(yOdd);
      scriptHexes.add('41' + uncompressedEven + 'ac');
      scriptHexes.add('41' + uncompressedOdd + 'ac');
      // Legacy P2PKH of the uncompressed keys.
      addresses.add(base58check(0x00, hash160(uncompressedEven)));
      addresses.add(base58check(0x00, hash160(uncompressedOdd)));
    }

    // P2PKH + P2WPKH of the compressed keys.
    for (const pub of [compressedEven, compressedOdd]) {
      const h = hash160(pub);
      addresses.add(base58check(0x00, h));
      addresses.add(bech32P2wpkh(h));
    }
  }

  return { scriptHexes, addresses };
}

// Mirror of loadKnownBurnAddresses: read the curated x-coordinates and expand.
export async function loadNumsMatcher(pool: Pool): Promise<NumsMatcher> {
  const { rows } = await pool.query('SELECT x_coord FROM nums_keys');
  return buildNumsMatcher(rows.map((r: any) => r.x_coord));
}
