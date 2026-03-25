# Proposal 006 - Multisig with Off-Curve Public Keys

Bare M-of-N multisig outputs where fewer than M of the embedded public keys are valid secp256k1
points can never accumulate enough valid signatures to be spent, making them provably unspendable.

| Field               | Value              |
|---------------------|--------------------|
| Author              | Anders Brownworth  |
| Status              | Draft              |
| Created             | 2026-03-25         |
| Category            | Provably Lost      |

## Abstract

Bitcoin bare multisig (P2MS) outputs embed all public keys directly in the `scriptPubKey`. To
spend an M-of-N output, the spender must provide M valid signatures, each corresponding to one of
the N listed keys. `OP_CHECKMULTISIG` verifies each signature against the embedded public keys,
and requires the keys to be valid points on the secp256k1 curve.

If K of the N embedded keys are off-curve (invalid), then at most N−K valid signatures can ever
be produced. If N−K < M (i.e. the number of valid keys is less than the required threshold), the
signing threshold can never be reached and the output is permanently unspendable.

This is an extension of Proposal 005 to multisig outputs. Note that an output is only flagged
when it is provably impossible to reach the threshold — if enough valid keys remain to satisfy M,
the output may still be spendable.

## Script Format

Bare multisig `scriptPubKey` hex format:

```
OP_M  [push_len key₁] [push_len key₂] … [push_len keyₙ]  OP_N  OP_CHECKMULTISIG
```

- `OP_M` / `OP_N`: opcodes `0x51`–`0x60` encoding values 1–16
- Each key is preceded by its length byte: `41` (65 bytes, uncompressed) or `21` (33 bytes, compressed)
- Script ends with `ae` (OP_CHECKMULTISIG)

## Implementation

Parse the script to extract M, N, and all pubkeys. Count how many keys are valid curve points
(using the same `isOnSecp256k1Curve` check from Proposal 005). If `validCount < M`, flag as lost:

```javascript
const parsed = parseMultisigScript(output.script_hex);
if (parsed !== null) {
    const validCount = parsed.pubkeys.filter(isOnSecp256k1Curve).length;
    if (validCount < parsed.m) {
        return true;
    }
}
```

## Scope Notes

- Only bare P2MS outputs are checked. P2SH-wrapped multisig embeds the redeem script in a hash,
  so the keys are not visible from the scriptPubKey alone.
- An output with all keys valid is unaffected — even if some keys are off-curve, as long as M
  valid keys remain, the output may still be spendable.
