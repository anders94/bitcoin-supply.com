# Proposal 001 - MtGox Error
MtGox created some manual transactions with UTXOs 

|---------------------|-------------------|
| Author              | Anders Brownworth |
| Status              | Final             |
| Created             | 2020-12-15        |
| Category            | Provably Lost     |
| First Seen in Block | 150,951           |
| Scale Estimate      | 2609.36304319 BTC |

## Abstract
First publically identified by *genjix* on https://bitcointalk.org/index.php?topic=50206.0 these
UTXOs have a standard transaction script but with the flaw that they fail to push the public key
onto the stack. Therefore, all of these outputs are permanently lost.

## Implementation
These UTXOs can be identified by checking to see if `script_asm` is `76a90088ac`:
```
output.script_hex == '76a90088ac'
```
