# Proposal 001 - MtGox Error
MtGox created some manual transactions with UTXOs 

| Field               | Value              |
|---------------------|--------------------|
| Author              | Anders Brownworth  |
| Status              | Final              |
| Created             | 2020-12-15         |
| Category            | Provably Lost      |
| First Seen in Block | 150,951            |
| Scale Estimate      | 2,609.36304319 BTC |

## Abstract
First publically identified by *genjix* on https://bitcointalk.org/index.php?topic=50206.0 these
UTXOs have a standard transaction script but with the flaw that they fail to push the public key
onto the stack. Therefore, all of these outputs are permanently lost.

## Implementation
These UTXOs can be identified by checking to see if `script_asm` is `76a90088ac`:
```
output.script_hex == '76a90088ac'
```

## Example
Transaction `0ca7f7299dc8d87c26c82badf9a303049098af050698c694fbec35c4b08fc3df` has this unspendable
100 BTC output:
```
      {
        "index": "0",
        "script_asm": "OP_DUP OP_HASH160 0 OP_EQUALVERIFY OP_CHECKSIG",
        "script_hex": "76a90088ac",
        "required_signatures": null,
        "type": "nonstandard",
        "addresses": [
          "nonstandard2cb6b5842f9d353ef44bb46407b03fed4673f4af"
        ],
        "value": "10000000000"
      },
```
