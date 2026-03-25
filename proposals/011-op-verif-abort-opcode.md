# Proposal 011 - OP_VERIF / OP_VERNOTIF Abort Opcodes

ScriptPubKey scripts containing `OP_VERIF` (0x65) or `OP_VERNOTIF` (0x66) are permanently
unspendable because these opcodes unconditionally abort script execution — even when they appear
inside an unexecuted `OP_IF` branch.

| Field               | Value              |
|---------------------|--------------------|
| Author              | Anders Brownworth  |
| Status              | Draft              |
| Created             | 2026-03-25         |
| Category            | Provably Lost      |

## Abstract

Bitcoin's script interpreter has a small set of opcodes that cause immediate, unconditional failure
regardless of the execution context. `OP_VERIF` (0x65) and `OP_VERNOTIF` (0x66) are two such
opcodes. Unlike most disabled opcodes (which only abort when actually executed), the interpreter
checks for these two opcodes before the branch-execution test — meaning that even if the opcode
sits inside an `OP_IF 0 OP_ELSE ... OP_ENDIF` branch that would never be reached, its mere
presence in the script causes the transaction to be invalid.

Any output whose scriptPubKey contains one of these bytes (as an opcode, not as push data) can
never be spent.

## Detection

The helper `containsAbortOpcode` walks the script byte-by-byte, correctly skipping over push-data
payloads so that `0x65` or `0x66` bytes embedded inside data pushes do not produce false positives.

```javascript
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
```

This check is placed between Proposal 004 (OP_RETURN) and the outer `else` block (Proposals
005+), so it is evaluated before any per-script-type analysis.

## Scope Notes

- Only `OP_VERIF` and `OP_VERNOTIF` are covered here. Other unconditionally-failing opcodes
  (e.g. `OP_RESERVED`, `OP_VER`) require execution context and are not included.
- The parser handles OP_PUSHDATA1 and OP_PUSHDATA2 to avoid false positives from data payloads.
  OP_PUSHDATA4 (0x4e) terminates the scan early; any script using OP_PUSHDATA4 to encode a
  payload containing `0x65`/`0x66` would itself be non-standard for other reasons.
