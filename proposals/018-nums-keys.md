# Proposal 018 - NUMS-Key Burns
Outputs paying to a documented nothing-up-my-sleeve (NUMS) public key, in any spendable wrapping,
are classified as *Probably Lost*.

| Field               | Value             |
| --------------------|-------------------|
| Author              | Anders Brownworth |
| Status              | Draft             |
| Created             | 2026-07-18        |
| Category            | Probably Lost     |
| Scale Estimate      | 0.01718034 BTC    |

## Abstract
A NUMS point is a public key whose construction is published and verifiable — for example
BIP-341's point `H = lift_x(SHA256(ser(G)))`, with x-coordinate
`50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0` — chosen precisely so that
nobody can know its discrete logarithm. Its intended use is as a taproot *internal* key to disable
key-path spending. When such a point instead appears as the *output* key (or as a P2PK key, or
hashed into a P2PKH/P2WPKH address), the coins are unspendable under standard cryptographic
assumptions: key-path spending requires the discrete log nobody has, and constructing a taproot
script-path opening for a fixed output key is a hash-puzzle of equivalent hardness.

This is the same assumption class as Proposal 012's burn addresses (hash-preimage resistance),
so NUMS-key burns share its *Probably Lost* bucket rather than the mathematically-certain
*Provably Lost* bucket. They are broken out as their own rule because the burn mechanism is
different in kind: a documented keyless *construction* rather than a pattern address.

## Implementation
Curated x-coordinates live in the `nums_keys` table (seeded with the BIP-341 point). At ETL
startup each x is expanded into every spendable wrapping, and outputs are matched exactly:

- `script_hex` forms: `5120‖x` (P2TR output key), `21 02/03‖x ac` (compressed P2PK),
  `41 04‖x‖y ac` for both y parities (uncompressed P2PK)
- address forms: P2PKH of the compressed and uncompressed keys, P2WPKH of the compressed keys

New NUMS constants can be added to the table without code changes.

## Quantum Caveat
Uniquely among burn classifications, NUMS-key burns are *quantum-recoverable*: the key is
on-curve and (in the P2TR/P2PK forms) fully exposed on-chain, so a cryptographically-relevant
quantum computer could derive its private key and spend these outputs. Hash-wrapped burns like
Proposal 012's are not recoverable this way while unspent, since no public key is revealed.
Following Proposal 016's convention, outputs already classified as lost are not additionally
tagged for the quantum lens; this caveat is recorded here instead.

## Example
The address `1D8eDztgv79J59V7UBBpNGnRE6hjstqKb5` — the P2PKH of the odd-parity compressed
BIP-341 NUMS key `03‖x` — holds 0.01718034 BTC across 2 UTXOs at the time of writing: coins
burned to a key that provably cannot sign.
