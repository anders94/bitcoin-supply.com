# Proposal 001 - Conflicting Coinbase Transaction IDs
Coinbase transactions where the miner uses the same transaction ID in more than one block
cause the earlier transaction not to be uniquely identifiable and therefore unspendable and
*provably lost*.

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
91,812 and 91,842. Each of the former transactions in these pairs (blocks 91,722 and 91,812)
is not uniquely identifiable and therefore not spendable causing two provably lost transactions
of 50 BTC each. (no fees were collectable in these blocks to the loss is confined to just the
new issuance)

## Detail
Block 91,722's coinbase transaction ID (the only one in the block) is
`e3bf3d07d4b0375638d5f1db5255fe07ba2c4cb067cd81b84ee974b6585fb468`. Block 91,880 coinbase
transaction ID is identical. Therefore, there is only one 50 BTC output in
the spendable set of transactions.

Additionally, block 91,812's coinbase transaction ID is
`d5d27987d2a3dfc724e359870c6644b40e497bdc0589a033220fe15429d88599` which is also shared by the
coinbase transaction in block 91,842.

Bonus trivia: Should one of these outputs be spent, (as of this writing, neither has) which of
the coinbase transactions it came from is undefined.

## Implementation
The coinbase transactions in blocks 91,722 and 91,812 are *provably lost*. We arbitrarily pick
the first of the two blocks to be the unspendable output.
```
if (block.block_number == 91722 || block.block_number == 91812)
  if (transaction.hash == 'e3bf3d07d4b0375638d5f1db5255fe07ba2c4cb067cd81b84ee974b6585fb468' ||
      transaction.hash == 'd5d27987d2a3dfc724e359870c6644b40e497bdc0589a033220fe15429d88599')
```
