# Proposal 015: P2PK Outputs — Quantum Vulnerable

| Field               | Value             |
|---------------------|-------------------|
| Author              | Anders Brownworth |
| Status              | Draft             |
| Created             | 2026-03-25        |
| Category            | Quantum Vulnerable|
| Scale Estimate      | ~1.1M BTC         |

## Problem

Pay-to-Public-Key (P2PK) outputs embed the full public key directly in the `scriptPubKey`.
This means any observer — including a quantum computer — can see the exact public key without
needing to wait for a spend.

A sufficiently powerful quantum computer running Shor's algorithm could derive the private key
from the public key and spend these outputs without the owner's cooperation.

## Detection

P2PK outputs are identified by their script structure:
- **Uncompressed**: `41 04 <x> <y> ac` (134 hex chars)
- **Compressed**: `21 02/03 <x> ac` (70 hex chars)

Only *valid* curve points are tagged (off-curve keys are already tagged by Proposal 005).

```typescript
// Uncompressed P2PK
if (hex.length === 134 && hex.startsWith('41') && hex.endsWith('ac')) {
  const pubkey = hex.slice(2, 132);
  if (isOnSecp256k1Curve(pubkey)) return '015';
}
// Compressed P2PK
if (hex.length === 70 && hex.startsWith('21') && hex.endsWith('ac')) {
  const prefix = hex.slice(2, 4);
  if ((prefix === '02' || prefix === '03') && isOnSecp256k1Curve(hex.slice(2, 68))) return '015';
}
```

## Classification

Loss bucket: **4** (Quantum only). These outputs are *not* considered lost under classical
cryptography — they are only at risk from a quantum attacker.

The quantum slider on the homepage shows cumulative exposure, targeting the largest P2PK
outputs first (optimal attacker strategy). These outputs are NOT included in the main
spectrum slider's "Provably Lost" or "Probably Lost" stops.

## Notable Examples

- Block 9's coinbase: Satoshi's P2PK output `0411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5cb2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3`
- Early mining era outputs (blocks 0–~170,000) predominantly used P2PK
