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

## Amendment (2026-10-13): receipts after exposure

The original implementation tagged only the UTXOs present at the address at the moment of the
revealing spend. A key, once on-chain, stays public, so a coin that arrives at the address
*later* is exactly as reachable — and exchange hot wallets receive constantly after their first
spend. The ETL now checks the address's exposure state as each output is inserted and tags the
new UTXO immediately. This was the single largest source of under-counting (≈2.3M BTC at the
time of the amendment). `scripts/backfill-quantum-exposure.ts --phase receipts` tags the
existing rows.

The same rule applies to P2SH-P2WPKH spends (`scriptSig` = `0014…`, key in `witness[1]`):
the address type is script-hash but the revealed secret is a single key, so it is 016, not
021.
