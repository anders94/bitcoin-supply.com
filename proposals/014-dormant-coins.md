# Proposal 014: Dormant Coins (Methodology)

| Field               | Value             |
|---------------------|-------------------|
| Author              | Anders Brownworth |
| Status              | Draft             |
| Created             | 2026-03-25        |
| Category            | Dormant           |
| Scale Estimate      | Variable          |

## Overview

"Dormant coins" are UTXOs that have remained unspent for an extended period of time.
This is not a loss detection rule in the traditional sense — it does not assign a loss bucket
to individual UTXOs. Instead, it powers the **dormancy slider** on the homepage.

## How It Works

The slider stop "Dormant" shows UTXOs that have not moved in N years (where N is controlled
by a sub-slider, range 1–20 years). These are queried dynamically:

```sql
SELECT SUM(value_sats), COUNT(*)
FROM utxos
WHERE loss_bucket = 0
  AND block_timestamp <= NOW() - INTERVAL '$N years'
```

Pre-computed breakpoints (1y, 3y, 5y, 7y, 10y, 15y, 20y) are stored in `loss_snapshots`
and updated hourly by the snapshot updater.

## Interpretation

- **1 year**: Very conservative — includes recently dormant coins that may just be HODLers
- **5 years**: Includes coins dormant since the 2017–2020 era
- **10 years**: Likely includes many lost wallets from the early Bitcoin period
- **20 years**: Near-certain losses; only the most ancient UTXOs

## Notable Consideration

The "Satoshi era" coinbase outputs (blocks 1–54,316) are a subset of dormant coins.
See Proposal 017 for a dedicated analysis of these outputs.
