# Proposal 005 - Off-Curve Public Key

P2PK outputs that embed an ECDSA public key not on the secp256k1 curve can never be spent.
`OP_CHECKSIG` will always fail for such keys, making these outputs permanently unspendable.

| Field               | Value              |
|---------------------|--------------------|
| Author              | Anders Brownworth  |
| Status              | Draft              |
| Created             | 2026-03-25         |
| Category            | Provably Lost      |

## Abstract

Bitcoin Pay-to-Public-Key (P2PK) outputs embed an ECDSA public key directly in the
`scriptPubKey`. To spend such an output, the spender must provide a valid signature over the
transaction hash using the corresponding private key. However, `OP_CHECKSIG` requires the embedded
key to be a valid point on the secp256k1 elliptic curve. If the key is not on the curve, no valid
private key exists for it, and the output can never be spent.

The secp256k1 curve is defined by the equation **y² = x³ + 7 (mod p)** where:

```
p = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
```

For an **uncompressed key** (`04 x y`), validity requires that the point (x, y) satisfies the
curve equation. For a **compressed key** (`02/03 x`), validity requires that a square root of
`x³ + 7 mod p` exists (i.e. `x³ + 7` is a quadratic residue mod p). If neither condition holds,
the key is off-curve and the output is provably unspendable.

Note: Only P2PK outputs are checked. P2PKH outputs contain only a hash of the key, so the
underlying key cannot be verified from the script alone.

## Implementation

P2PK outputs are identified by their `script_hex` structure:

- **Uncompressed**: `41` + `04` + 32 bytes (x) + 32 bytes (y) + `ac` — total 134 hex chars
- **Compressed**: `21` + `02` or `03` + 32 bytes (x) + `ac` — total 70 hex chars

The curve check is performed using BigInt arithmetic:

```javascript
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
```

For uncompressed keys, validity is checked as: `(y² mod p) === (x³ + 7) mod p`

For compressed keys, validity is checked using Euler's criterion: `rhs^((p-1)/2) mod p === 1`
where `rhs = (x³ + 7) mod p`.
