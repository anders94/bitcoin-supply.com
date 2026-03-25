# Proposal 008 - SegWit v0 Wrong Program Length

SegWit v0 outputs with a witness program length that is neither 20 nor 32 bytes are permanently
unspendable by consensus rule, making their value provably lost.

| Field               | Value              |
|---------------------|--------------------|
| Author              | Anders Brownworth  |
| Status              | Draft              |
| Created             | 2026-03-25         |
| Category            | Provably Lost      |

## Abstract

BIP 141 defines two valid SegWit v0 witness program lengths:
- **20 bytes** — P2WPKH (Pay to Witness Public Key Hash)
- **32 bytes** — P2WSH (Pay to Witness Script Hash)

The BIP 141 consensus rule states: "If the version byte is 0, but the witness program is neither
20 nor 32 bytes, the script MUST fail." This means any `OP_0 <N-byte program>` output where
N ∈ [2, 40] and N ≠ 20 and N ≠ 32 can never be spent under current consensus rules, regardless
of the witness data provided.

## Script Format

```
OP_0 OP_PUSHBYTES_N <N-byte program>
```

Hex: `00` + push-byte + program bytes

Valid programs: `0014...` (20 bytes, P2WPKH) and `0020...` (32 bytes, P2WSH).

## Detection

Parse the push byte and verify it falls in [2, 40] (BIP 141 witness program range) but is neither
20 nor 32, and that the total script length is consistent with the declared push length.

```javascript
else if (hex.startsWith('00') && hex.length >= 8) {
    const pushByte = parseInt(hex.slice(2, 4), 16);
    if (pushByte >= 2 && pushByte <= 40 &&         // BIP141 valid range
        pushByte !== 20 && pushByte !== 32 &&       // not P2WPKH or P2WSH
        hex.length === 4 + pushByte * 2) {          // total length consistent
        return true;
    }
}
```

## Scope Notes

- Programs of length 0 or 1 are also technically invalid but handled separately; only 2–40 byte
  programs are considered here as BIP 141 specifies this range for witness programs.
- SegWit v2–v16 are governed by different rules (currently "anyone can spend" under BIP 141 for
  unknown versions); only v0 has the strict length requirement enforced at consensus.
