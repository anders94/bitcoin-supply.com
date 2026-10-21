# Proposal 020: Bare Multisig Outputs — Quantum Vulnerable

| Field               | Value             |
|---------------------|-------------------|
| Author              | Anders Brownworth |
| Status              | Draft             |
| Created             | 2026-10-13        |
| Category            | Quantum Vulnerable|
| Scale Estimate      | ~400 BTC          |

## Problem

A bare multisig (P2MS) output is `OP_M <key>…<key> OP_N OP_CHECKMULTISIG` with every cosigner
key written into the `scriptPubKey`. A quantum attacker derives the private key for any M of
the N on-curve keys and spends the output. Like P2PK and P2TR, exposure is static: the keys are
public from creation.

## Detection

Parse the standard template (the same parser Proposal 006 uses). Tag when at least M of the
N keys are valid curve points:

```typescript
const ms = parseMultisigScript(hex);
if (ms && ms.pubkeys.filter(isValidPubkey).length >= ms.m) return '020';
```

Scripts with fewer than M valid keys cannot be spent by anyone and are Proposal 006
(provably lost). Non-template scripts ending in `OP_CHECKMULTISIG` are not tagged.

## Classification

Loss bucket: **4** (Quantum only). The on-curve keys are stored comma-joined in `pubkey_hex`.
Bare multisig outputs carry no address, so they appear in the quantum lens per output, as P2PK
outputs do.

## Notes

Most bare multisig outputs were created in 2013–2014 as a data-embedding workaround; many carry
deliberately invalid keys (006) and most of the rest are dust. The scale is small, but the rule
closes the set of key-in-script output types so the quantum total has no known omissions.
