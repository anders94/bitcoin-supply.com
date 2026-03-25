# Proposal 009 - Wrong-Length Hash Push in P2PKH / P2SH

P2PKH and P2SH outputs where the embedded hash push length is not 20 bytes are permanently
unspendable, because `OP_HASH160` always produces exactly 20 bytes and the comparison can never
succeed.

| Field               | Value              |
|---------------------|--------------------|
| Author              | Anders Brownworth  |
| Status              | Draft              |
| Created             | 2026-03-25         |
| Category            | Provably Lost      |

## Abstract

### P2PKH

Standard P2PKH execution: the spending scriptSig pushes a pubkey and signature; the script then
executes `OP_DUP OP_HASH160` to hash the pubkey to exactly 20 bytes, then `OP_EQUALVERIFY`
compares the hash to the pushed value. If the pushed value is not 20 bytes, the comparison of
differently-sized values always fails — the output is unspendable regardless of the spending input.

### P2SH

Standard P2SH execution ends with `OP_HASH160 <push> OP_EQUAL`. `OP_HASH160` always returns 20
bytes. If `<push>` is not 20 bytes, `OP_EQUAL` always returns false and the spend fails.

Note: Proposal 003 (MtGox) already handles the specific zero-length case `76a90088ac`. This
proposal covers all other non-20-byte lengths (1–19 and 21–75 bytes).

## Script Formats

**P2PKH**: `76 a9 [push-byte] [data] 88 ac`
- `76` = OP_DUP, `a9` = OP_HASH160, `88` = OP_EQUALVERIFY, `ac` = OP_CHECKSIG
- Standard: push-byte = `14` (20 bytes)

**P2SH**: `a9 [push-byte] [data] 87`
- `a9` = OP_HASH160, `87` = OP_EQUAL
- Standard: push-byte = `14` (20 bytes)

## Detection

For each format, parse the push byte and flag if it is a direct push (≤ 0x4b), the script length
is consistent with the declared length, and the push length is not 20.

```javascript
// P2PKH: 76 a9 [push] [data] 88 ac
if (hex.startsWith('76a9') && hex.endsWith('88ac') && hex.length >= 10) {
    const pushByte = parseInt(hex.slice(4, 6), 16);
    if (pushByte <= 0x4b &&
        hex.length === 6 + pushByte * 2 + 4 &&
        pushByte !== 20) {
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
```

## Scope Notes

- Only direct push opcodes (≤ 0x4b) are checked. OP_PUSHDATA variants could theoretically be
  used but would produce non-standard scripts that are also unspendable for other reasons.
- Proposal 003 (MtGox zero-byte hash) is evaluated before this proposal and catches `76a90088ac`,
  so there is no double-counting.
