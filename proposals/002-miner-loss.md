# Proposal 002 - Miner Loss
Coinbase transactions where the miner doesn't claim some or all of the available new coin
issuance and fees represents *Provably Lost* coin.

| Field               | Value             |
| --------------------|-------------------|
| Author              | Anders Brownworth |
| Status              | Final             |
| Created             | 2020-12-18        |
| Category            | Provably Lost     |
| First Seen in Block | 124,724           |
| Scale Estimate      | xxxxxxxxxxx BTC   |

## Abstract
All blocks below height 6,930,000 include a reward of new coin issuance. If miners fail to
claim some or all of that reward, that new coin is never created and causes less than the
expected amount of coin to exist. Additionally, if the miner fails to collect some or all
of the fees transactions surrender within the block, that coin is also permanently lost.

## Detail
As both new coin issuance and fees collected are added together to create the value of the
coinbase transaction, it isn't always clear which part of the calculation caused miner loss.

Not claiming some or all available new coin issuance leads to less than the expected new
supply to be created. However, not claiming fees decreases the total supply in the system.
It isn't always clear if a miner isn't accepting new coin issuance or declining fees
because both values are added together. It is also not clear if a miner simply made a
mistake or is voulentarily choosing no to accept supply available to them.

As new coin issuance halves every 210,000 blocks, fees likely become a larger and larger
percentage of the overall reward available to a miner. While net supply loss due to miner
error is always possible, it will probably become more likely as more halvings happen.

## Implementation
A block's `allowed_supply` is its subsidy plus the fees its transactions surrender. When the
coinbase claims less than that, the difference is provably lost supply.
```
block.allowed_supply = subsidy(block.height) + block.fees;
block.supply_loss    = max(0, block.allowed_supply - block.coinbase_value);
```
The loss is recorded per block (`blocks.miner_loss_sats`), not per UTXO: the coin was never
created, so no output carries it. The largest single loss is block 501,726 (December 2017),
whose miner claimed nothing and left the whole 12.5 BTC subsidy unissued.

## Example
Block `124724` looses 0.01000001 BTC 
```
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```
