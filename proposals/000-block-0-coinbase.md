# Proposal 000 - Block 0 Coinbase
The coinbase transaction in the first block (0) is not included in the spendable UTXO set
by the bitcoin software and is therefore *provably lost*.

| Field               | Value             |
| --------------------|-------------------|
| Author              | Anders Brownworth |
| Status              | Final             |
| Created             | 2020-12-18        |
| Category            | Provably Lost     |
| First Seen in Block | 0                 |
| Scale Estimate      | 50 BTC            |

## Abstract
Bitcoin's source code excludes the coinbase transaction in block 0 from the spendable outputs.
It is unclear if this was deliberatly done but at this point is considered highly unlikely to
be reversed so this coin is considered provably lost.

```
if (block.block_number == 0)
```
