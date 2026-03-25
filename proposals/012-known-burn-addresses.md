# Proposal 012: Known Burn Addresses

| Field               | Value             |
|---------------------|-------------------|
| Author              | Anders Brownworth |
| Status              | Final             |
| Created             | 2026-03-25        |
| Category            | Probably Lost     |
| Scale Estimate      | TBD (ongoing)     |

## Problem

Certain Bitcoin addresses were constructed with no known corresponding private key. Senders
who intentionally want to destroy bitcoin use these addresses. Unlike Proposal 000–011 (provably
lost), these are *probably* lost — it is theoretically conceivable (though astronomically unlikely)
that someone could brute-force or find the private key.

## Known Addresses

- `1BitcoinEaterAddressDontSendf59kuE` — canonical "eater" address, widely used for intentional burns
- `1111111111111111111114oLvT2` — P2PKH of all-zero hash160 (no preimage known)
- `1HELLowoRLD62pG6oLZXRbhW3uHnFpEBqV` — vanity burn address
- `1BitcoinEaterAddressDontSendkbykwk` — second canonical eater address variant

## Detection

Exact address match against the `known_burn_addresses` table, seeded at deployment time.
New entries can be added without code changes.

```typescript
if (ctx.address && ctx.knownBurnAddresses.has(ctx.address)) return '012';
```

## Classification

Loss bucket: **2** (Probably Lost). These outputs are included in the "Probably Lost" stop on
the main slider but excluded from "Provably Lost".
