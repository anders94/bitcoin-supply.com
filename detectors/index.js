const SECP256K1_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;

function modpow(base, exp, mod) {
    let result = 1n;
    base = base % mod;
    while (exp > 0n) {
        if (exp % 2n === 1n) result = (result * base) % mod;
        exp = exp / 2n;
        base = (base * base) % mod;
    }
    return result;
}

// Parses a bare M-of-N multisig scriptPubKey hex.
// Format: OP_M [push+key]×N OP_N OP_CHECKMULTISIG
// Returns { m, n, pubkeys } or null if not a standard multisig script.
function parseMultisigScript(hex) {
    if (!hex.endsWith('ae')) return null;
    const mOpcode = parseInt(hex.slice(0, 2), 16);
    if (mOpcode < 0x51 || mOpcode > 0x60) return null;
    const m = mOpcode - 0x50;
    const pubkeys = [];
    let pos = 2;
    const end = hex.length - 4; // OP_N (2) + 'ae' (2)
    while (pos < end) {
        const lenByte = hex.slice(pos, pos + 2);
        if (lenByte === '41') {          // uncompressed: push 65 bytes
            pubkeys.push(hex.slice(pos + 2, pos + 132));
            pos += 132;
        } else if (lenByte === '21') {   // compressed: push 33 bytes
            pubkeys.push(hex.slice(pos + 2, pos + 68));
            pos += 68;
        } else {
            return null;
        }
    }
    if (pos !== end) return null;
    const nOpcode = parseInt(hex.slice(end, end + 2), 16);
    if (nOpcode < 0x51 || nOpcode > 0x60) return null;
    const n = nOpcode - 0x50;
    if (pubkeys.length !== n || m > n) return null;
    return { m, n, pubkeys };
}

function isOnSecp256k1Curve(pubkeyHex) {
    const p = SECP256K1_P;
    const prefix = pubkeyHex.slice(0, 2);
    if (prefix === '04' && pubkeyHex.length === 130) {
        const x = BigInt('0x' + pubkeyHex.slice(2, 66));
        const y = BigInt('0x' + pubkeyHex.slice(66, 130));
        if (x === 0n || x >= p || y === 0n || y >= p) return false;
        const x3 = (x * x % p * x) % p;
        return (y * y) % p === (x3 + 7n) % p;
    } else if ((prefix === '02' || prefix === '03') && pubkeyHex.length === 66) {
        const x = BigInt('0x' + pubkeyHex.slice(2, 66));
        if (x === 0n || x >= p) return false;
        const x3 = (x * x % p * x) % p;
        const rhs = (x3 + 7n) % p;
        return modpow(rhs, (p - 1n) / 2n, p) === 1n;
    }
    return false;
}

function containsAbortOpcode(hex) {
    let pos = 0;
    while (pos + 1 < hex.length) {
        const opcode = parseInt(hex.slice(pos, pos + 2), 16);
        pos += 2;
        if (opcode === 0x65 || opcode === 0x66) return true;
        if (opcode >= 0x01 && opcode <= 0x4b) {
            pos += opcode * 2;         // skip N data bytes
        } else if (opcode === 0x4c) {  // OP_PUSHDATA1
            if (pos + 2 > hex.length) break;
            const len = parseInt(hex.slice(pos, pos + 2), 16);
            pos += 2 + len * 2;
        } else if (opcode === 0x4d) {  // OP_PUSHDATA2 (little-endian)
            if (pos + 4 > hex.length) break;
            const len = parseInt(hex.slice(pos, pos + 2), 16) +
                        parseInt(hex.slice(pos + 2, pos + 4), 16) * 256;
            pos += 4 + len * 2;
        } else if (opcode === 0x4e) {  // OP_PUSHDATA4: break for safety
            break;
        }
    }
    return false;
}

module.exports = {
    blockLoss: (block) => {
	// Proposal 002 - Miner Loss
        if (block.allowed_supply != block.new_supply)
	    return true;
	else
	    return false;
    },
    outputLoss: (block, transaction, output) => {
	// Proposal 000 - Block 0 Coinbase
	if (block.number == 0) {
	    return true;
	}
	// Proposal 001 - Conflicting Coinbase Transaction IDs
	else if (block.number == 91722 || block.number == 91812) {
	    if (transaction.hash == 'e3bf3d07d4b0375638d5f1db5255fe07ba2c4cb067cd81b84ee974b6585fb468' ||
		transaction.hash == 'd5d27987d2a3dfc724e359870c6644b40e497bdc0589a033220fe15429d88599') {
		return true;
	    }
	}
	// Proposal 003 - MtGox Error
	else if (output.script_hex == '76a90088ac') { // MtGox error
	    return true;
	}
	// Proposal 004 - OP_RETURN
	else if (output.script_hex.startsWith('6a')) { // OP_RETURN losses (includes bare 6a)
	    return true;
	}
	// Proposal 011 - OP_VERIF / OP_VERNOTIF abort opcodes
	else if (containsAbortOpcode(output.script_hex)) {
	    return true;
	}
	// Proposal 005 - Off-Curve Public Key
	else {
	    const hex = output.script_hex;
	    let pubkeyHex = null;
	    // Uncompressed P2PK: push(65) + 04 + x(32) + y(32) + OP_CHECKSIG
	    if (hex.length === 134 && hex.startsWith('41') && hex.endsWith('ac')) {
		pubkeyHex = hex.slice(2, 132);
	    }
	    // Compressed P2PK: push(33) + 02/03 + x(32) + OP_CHECKSIG
	    else if (hex.length === 70 && hex.startsWith('21') &&
		     (hex.slice(2, 4) === '02' || hex.slice(2, 4) === '03') && hex.endsWith('ac')) {
		pubkeyHex = hex.slice(2, 68);
	    }
	    if (pubkeyHex !== null && !isOnSecp256k1Curve(pubkeyHex)) {
		return true;
	    }
	    // Proposal 006 - Multisig with Off-Curve Public Keys
	    const parsed = parseMultisigScript(hex);
	    if (parsed !== null) {
		const validCount = parsed.pubkeys.filter(isOnSecp256k1Curve).length;
		if (validCount < parsed.m) {
		    return true;
		}
	    }
	    // Proposal 007 - Taproot off-curve x-only key
	    if (hex.length === 68 && hex.startsWith('5120')) {
		const x = BigInt('0x' + hex.slice(4, 68));
		if (x === 0n || x >= SECP256K1_P) {
		    return true;
		}
		const x3 = (x * x % SECP256K1_P * x) % SECP256K1_P;
		const rhs = (x3 + 7n) % SECP256K1_P;
		if (modpow(rhs, (SECP256K1_P - 1n) / 2n, SECP256K1_P) !== 1n) {
		    return true;
		}
	    }
	    // Proposal 008 - SegWit v0 wrong program length
	    else if (hex.startsWith('00') && hex.length >= 8) {
		const pushByte = parseInt(hex.slice(2, 4), 16);
		if (pushByte >= 2 && pushByte <= 40 &&         // BIP141 valid range
		    pushByte !== 20 && pushByte !== 32 &&       // not P2WPKH or P2WSH
		    hex.length === 4 + pushByte * 2) {          // total length consistent
		    return true;
		}
	    }
	    // Proposal 009 - Wrong-length hash push in P2PKH/P2SH
	    else {
		// P2PKH: 76 a9 [push] [data] 88 ac
		if (hex.startsWith('76a9') && hex.endsWith('88ac') && hex.length >= 10) {
		    const pushByte = parseInt(hex.slice(4, 6), 16);
		    if (pushByte <= 0x4b &&                          // direct push only
			hex.length === 6 + pushByte * 2 + 4 &&      // consistent total length
			pushByte !== 20) {                           // not standard 20-byte hash
			return true;
		    }
		}
		// P2SH: a9 [push] [data] 87
		else if (hex.startsWith('a9') && hex.endsWith('87') && hex.length >= 8) {
		    const pushByte = parseInt(hex.slice(2, 4), 16);
		    if (pushByte <= 0x4b &&
			hex.length === 4 + pushByte * 2 + 2 &&
			pushByte !== 20) {
			return true;
		    }
		}
	    }
	    // Proposal 010 - P2PK with invalid key encoding
	    if (hex.endsWith('ac')) {
		const pb = parseInt(hex.slice(0, 2), 16);
		if (pb >= 1 && pb <= 0x4b && hex.length === (pb + 2) * 2) {
		    if (pb !== 33 && pb !== 65) {
			return true; // wrong-length key — can never be valid
		    } else if (pb === 33 &&
			       hex.slice(2, 4) !== '02' && hex.slice(2, 4) !== '03') {
			return true; // 33-byte with invalid prefix
		    }
		    // pb === 65 with invalid prefix: already caught by Proposal 005
		}
	    }
	}
	return false;
    }
}
