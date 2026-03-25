import { ClassifierInput } from './proposals-000-011.js';
import { isOnSecp256k1Curve } from './proposals-000-011.js';

// Tag valid P2PK outputs as quantum-vulnerable (pubkey in script, known to attacker)
export function classifyP2PKQuantum(ctx: ClassifierInput): '015' | null {
  const hex = ctx.script_hex;
  // Uncompressed: 41 + 04 + 64 bytes + ac = 134 chars
  if (hex.length === 134 && hex.startsWith('41') && hex.endsWith('ac')) {
    const prefix = hex.slice(2, 4);
    if (prefix === '04') {
      const pubkey = hex.slice(2, 132);
      if (isOnSecp256k1Curve(pubkey)) return '015';
    }
  }
  // Compressed: 21 + 02/03 + 32 bytes + ac = 70 chars
  if (hex.length === 70 && hex.startsWith('21') && hex.endsWith('ac')) {
    const prefix = hex.slice(2, 4);
    if (prefix === '02' || prefix === '03') {
      const pubkey = hex.slice(2, 68);
      if (isOnSecp256k1Curve(pubkey)) return '015';
    }
  }
  return null;
}
