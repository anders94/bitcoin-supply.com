# Proposal 010 - P2PK with Invalid Key Encoding

P2PK outputs where the pushed key has an invalid length or an invalid prefix byte are permanently
unspendable because `OP_CHECKSIG` immediately returns false for any key it cannot parse.

| Field               | Value              |
|---------------------|--------------------|
| Author              | Anders Brownworth  |
| Status              | Draft              |
| Created             | 2026-03-25         |
| Category            | Provably Lost      |

## Abstract

A P2PK scriptPubKey has the form `[push-byte] [key-data] OP_CHECKSIG`. Bitcoin's `OP_CHECKSIG`
implementation validates the key before attempting signature verification:

- An **uncompressed** public key must be exactly 65 bytes with prefix `04`.
- A **compressed** public key must be exactly 33 bytes with prefix `02` or `03`.

Any other encoding causes `OP_CHECKSIG` to return false unconditionally, making the output
permanently unspendable.

## Relationship to Proposal 005

Proposal 005 (Off-Curve Public Key) already handles:
- 65-byte push (`0x41`) with `04` prefix + off-curve point
- 33-byte push (`0x21`) with `02`/`03` prefix + off-curve x-coordinate

This proposal covers the remaining gaps:
- **33-byte push with prefix ≠ `02`/`03`** (e.g. `05`, `00`): rejected before any curve check
- **Any push length other than 33 or 65**: wrong-size key, rejected immediately

## Script Format

`[push-byte] [key-bytes] ac`

- `push-byte` is a direct push opcode: 1–0x4b (1–75 bytes of key data)
- `ac` = OP_CHECKSIG
- Total hex length = (push-byte + 2) × 2 characters

## Detection

```javascript
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
```

## Scope Notes

- Only direct push opcodes (≤ 0x4b) are checked. An OP_PUSHDATA variant would produce a
  non-standard script that is also unspendable for other reasons.
- The 65-byte / invalid-prefix case (`41` + non-`04` prefix) is already caught by Proposal 005
  (`isOnSecp256k1Curve` returns false for unrecognised prefixes), so this proposal does not
  double-count it.
- This detector runs after Proposals 007–009 inside the outer `else` block.
