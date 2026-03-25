# Proposal 016: Exposed P2PKH — Quantum Vulnerable

| Field               | Value             |
|---------------------|-------------------|
| Author              | Anders Brownworth |
| Status              | Draft             |
| Created             | 2026-03-25        |
| Category            | Quantum Vulnerable|
| Scale Estimate      | TBD               |

## Problem

P2PKH (Pay-to-Public-Key-Hash) outputs initially hide the public key behind a hash, providing
a layer of quantum resistance. However, once an address has been used to *send* bitcoin, the
public key is revealed in the scriptSig of the spending transaction.

Any remaining unspent UTXOs at that same address are now quantum-vulnerable: a quantum attacker
can compute the private key from the exposed public key and sweep the remaining balance.

## Detection

When processing inputs, extract the public key from:
1. `scriptSig.asm` for P2PKH (last element is the pubkey)
2. `txinwitness[1]` for P2WPKH (second witness element is the pubkey)

Once extracted, tag all remaining UTXOs at that address:

```typescript
// Mark remaining UTXOs at the address
UPDATE utxos
SET pubkey_exposed = TRUE, pubkey_hex = $2,
    loss_rules = array_append(loss_rules, '016')
WHERE address = $1 AND pubkey_exposed = FALSE
```

## Classification

Loss bucket: **4** (Quantum only) for UTXOs that have no other loss classification.

Note: UTXOs already classified as provably or probably lost are not re-tagged with '016' —
the quantum tag is only meaningful for UTXOs that are otherwise spendable.

## Relationship to Proposal 015

- Proposal 015: Public key is always visible (in P2PK script), exposure is static
- Proposal 016: Public key becomes visible at first spend, exposure is dynamic

Combined, Proposals 015 + 016 define the full quantum exposure set tracked in the
`quantum_all_exposed` snapshot.
