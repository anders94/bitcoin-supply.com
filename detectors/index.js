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
	else if (output.script_asm.startsWith('OP_RETURN ')) { // OP_RETURN losses
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
	}
	return false;
    }
}
