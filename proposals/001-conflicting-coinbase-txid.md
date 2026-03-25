# Proposal 001 - Conflicting Coinbase Transaction IDs
Transactions where the miner uses the same transaction ID in the coinbase of more than one
block cause the two transactions not to be uniquely identifiable. Therefore, one of the
two coinbase transactions is *provably lost*.

| Field               | Value             |
| --------------------|-------------------|
| Author              | Anders Brownworth |
| Status              | Final             |
| Created             | 2020-12-18        |
| Category            | Provably Lost     |
| First Seen in Block | 91,722            |
| Scale Estimate      | 100 BTC           |

## Abstract
Bitcoin is spent by being identified by transaction ID and index number. Early versions of
the bitcoin software allowed identical transaction IDs to be used in the coinbase transaction.
There were two occurrences of this, one in blocks 91,722 and 91,880 and the other in blocks
91,812 and 91,842. The spendable UTXO set only includes only one transaction for each pair of
blocks causing two losses of 50 BTC each. (no fees were collectable in these blocks, simplifying
the analisys)

## Detail
Block 91,722's coinbase transaction ID (the only one in the block) is
`e3bf3d07d4b0375638d5f1db5255fe07ba2c4cb067cd81b84ee974b6585fb468`. Block 91,880's coinbase
transaction ID is identical. Therefore, there is only one 50 BTC output in the spendable set of
transactions implying a loss of 50 BTC amongst this pair of blocks.

Additionally, block 91,812's coinbase transaction ID is
`d5d27987d2a3dfc724e359870c6644b40e497bdc0589a033220fe15429d88599` which is also shared by the
coinbase transaction in block 91,842. Because there is only one 50 BTC output in the spendable
set of transactions, this implies a loss of 50 BTC amongst this pair of blocks as well.

Bonus trivia: The transaction IDs in the spendable set are not strictly related to the transactions
that created them. Which block the coinbase transactions
`e3bf3d07d4b0375638d5f1db5255fe07ba2c4cb067cd81b84ee974b6585fb468` and
`d5d27987d2a3dfc724e359870c6644b40e497bdc0589a033220fe15429d88599` came from is undefined.

## Implementation
We arbitrarily pick the coinbase transactions in earlier blocks (91,722 and 91,812) as the
*provably lost* supply.
```
if (block.block_number == 91722 || block.block_number == 91812)
  if (transaction.hash == 'e3bf3d07d4b0375638d5f1db5255fe07ba2c4cb067cd81b84ee974b6585fb468' ||
      transaction.hash == 'd5d27987d2a3dfc724e359870c6644b40e497bdc0589a033220fe15429d88599')
```
