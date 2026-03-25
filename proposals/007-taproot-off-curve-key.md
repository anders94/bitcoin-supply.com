# Proposal 007 - Taproot Off-Curve x-Only Key

Taproot outputs where the embedded x-only public key is not a valid point on the secp256k1 curve
are permanently unspendable, making their value provably lost.

| Field               | Value              |
|---------------------|--------------------|
| Author              | Anders Brownworth  |
| Status              | Draft              |
| Created             | 2026-03-25         |
| Category            | Provably Lost      |

## Abstract

Taproot outputs (SegWit v1, BIP 341) encode a 32-byte x-only public key directly in the
`scriptPubKey`. Both key-path and script-path spending require this output key to be a valid point
on the secp256k1 curve. If the x-coordinate has no corresponding y (i.e. x³+7 is not a quadratic
residue mod p), no valid Taproot spend is possible under any circumstances.

## Script Format

```
OP_1 OP_PUSHBYTES_32 <32-byte x-only key>
```

Hex: `5120` + 64 hex chars (total 68 hex chars / 34 bytes)

## Detection

Apply the Euler criterion: compute `rhs = (x³+7) mod p` and check whether
`rhs^((p−1)/2) mod p == 1`. If not, x has no square root mod p and the key is off-curve.

Edge cases: x=0 and x≥p are also invalid.

```javascript
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
```

## Scope Notes

- Only the `scriptPubKey` output key is checked. Internal Taproot keys embedded in script leaves
  are not visible from the output and are not evaluated here.
- This is the Taproot analogue of Proposal 005 (off-curve P2PK key) and Proposal 006 (off-curve
  multisig key).
