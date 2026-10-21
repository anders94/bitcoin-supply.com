# Proposal 019: Taproot Outputs — Quantum Vulnerable

| Field               | Value             |
|---------------------|-------------------|
| Author              | Anders Brownworth |
| Status              | Draft             |
| Created             | 2026-10-13        |
| Category            | Quantum Vulnerable|
| Scale Estimate      | ~220k BTC         |

## Problem

A Pay-to-Taproot (P2TR) output's `scriptPubKey` is `OP_1 <32-byte x-only key>`. That key is the
*output key* `Q = P + t·G`, a point on secp256k1 published in full. A quantum attacker running
Shor's algorithm computes the discrete log of `Q` directly and produces a valid key-path
signature. Whether the output was built with a script tree, and whatever that tree contains, is
irrelevant: key-path spending only requires a signature for `Q`.

This is the same exposure class as Proposal 015's P2PK outputs — the key is visible from the
moment the output is created, before any spend.

## Detection

```typescript
// 5120 || x (32 bytes)
const m = /^5120([0-9a-f]{64})$/.exec(hex);
if (m && isXOnlyOnCurve(m[1])) return '019';
```

`isXOnlyOnCurve` checks that `x³ + 7` is a quadratic residue mod p (BIP-340 lifts the even-y
point). Off-curve x values are already Proposal 007 (provably lost) and are not tagged here.

## Classification

Loss bucket: **4** (Quantum only). Not a loss under classical assumptions.

The 32-byte x-only key is stored as the output's `pubkey_hex`; the address's `exposure_kind`
is `p2tr`.

## Interaction with other rules

- **007** (off-curve x): takes precedence, bucket 1, never tagged 019.
- **018** (NUMS output key): tagged both 018 and 019; the bucket ladder places it in bucket 2
  (probably lost). As 018 notes, a NUMS output key is still quantum-recoverable, and the
  exposed flag is set, so the quantum lens includes it.

## Relationship to Proposal 015

Identical mechanism — key in the output script — for the newest output type rather than the
oldest. Together with Proposal 020 (bare multisig) these three rules define "exposed from
creation"; Proposals 016 and 021 define "exposed from first spend".
