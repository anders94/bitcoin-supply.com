# Proposal 000 - OP_RETURN
UTXOs with scripts beginning with `OP_RETURN` are unspendable and should be classified as *Provably
Lost*.

| Field               | Value             |
| --------------------|-------------------|
| Author              | Anders Brownworth |
| Status              | Final             |
| Created             | 2020-12-15        |
| Category            | Provably Lost     |
| First Seen in Block | 247,633           |
| Scale Estimate      | 12.10237381 BTC   |

## Abstract
Use of transactions with `OP_RETURN` outputs is a common way to record arbitrary data in the bitcoin
blockchain. While these outputs usually have a value of '0', some consume positive amounts. These
UTXOs are unspendable by nature and therefore represent supply loss.

## Implementation
These UTXOs can be identified by checking to see if `script_asm` starts with `OP_RETURN `:
```
output.script_asm.startsWith('OP_RETURN ')
```

## Example
Transaction `139c004f477101c468767983536caaeef568613fab9c2ed9237521f5ff530afd` has the following
output:
```
    {
      value: 0.001,
      n: 1,
      scriptPubKey: {
        asm: 'OP_RETURN d68bdab455902dcc59f4e8f775a59c58ea8ae8f0a6cb7f3b96f8a3cfd84c9af7',
        hex: '6a20d68bdab455902dcc59f4e8f775a59c58ea8ae8f0a6cb7f3b96f8a3cfd84c9af7',
        type: 'nulldata'
      }
    }
```
