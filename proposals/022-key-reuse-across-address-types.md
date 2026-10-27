# Proposal 022: Key Reuse Across Address Types — Quantum Vulnerable

| Field               | Value             |
|---------------------|-------------------|
| Author              | Anders Brownworth |
| Status              | Draft             |
| Created             | 2026-10-26        |
| Category            | Quantum Vulnerable|
| Scale Estimate      | 2,386 BTC (measured at block 973321) |

## Problem

One private key controls more than one address. Its public key has two encodings, compressed
and uncompressed, and each encoding can be paid three ways that commit to the key's HASH160:

| Address type  | Script                                          |
|---------------|-------------------------------------------------|
| P2PKH         | `OP_DUP OP_HASH160 <h> OP_EQUALVERIFY OP_CHECKSIG` |
| P2WPKH        | `0 <h>`                                         |
| P2SH-P2WPKH   | `OP_HASH160 HASH160(0014 <h>) OP_EQUAL`          |

Proposals 015, 016, 019, 020 and 021 flag the address where a key became public. But a quantum
attacker who recovers the private key can spend from every address that key controls, not only
the one where it was seen. Coins at a key's *sibling* addresses are exposed the moment the key is.

The clearest case is the genesis block. Its coinbase pays a P2PK output, so its key has been public
since 2009, and the P2PKH address of that key, `1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa`, holds tens of
BTC sent as tribute. Until this rule none of it was counted: P2PK outputs carry no address of
their own, so nothing linked the key to the P2PKH address.

## Detection

Whenever a key becomes known — in an output script (015 P2PK, 020 bare multisig) or in a spend
(016 single key, 021 every key in a revealed script) — derive its sibling addresses and treat each
as revealed by the same key:

- **Uncompressed key** (65 bytes): all six addresses, three from each encoding.
- **Compressed key** (33 bytes): the three from the compressed encoding only. Recovering the
  uncompressed form needs a modular square root per key, and no wallet pays the uncompressed
  addresses of a key it uses compressed.

Taproot output keys (019) are excluded: they are tweaked x-only keys, which no single-key address
type commits to.

Matching addresses get `exposure_kind = 'reuse'`, and every coin at them that is not already
exposed is tagged, exactly as in 016:

```sql
UPDATE utxos SET pubkey_exposed = TRUE, pubkey_hex = $key,
  loss_rules = array_append(loss_rules, '022')   -- bucket 0 rows only
WHERE address = $1 AND pubkey_exposed = FALSE AND loss_bucket IN (0, 4)
```

Later receipts at a marked address are tagged on arrival by the existing receipt path.

Uncompressed and hybrid (`06` / `07`, see 005) keys yield the addresses of both standard
encodings, plus the hybrid encoding's own.

## Classification

Loss bucket: **4** (Quantum only) for UTXOs with no other loss classification.

On the quantum page these coins count in the "key revealed by a spend" category (P2PKH / P2WPKH /
P2SH-P2WPKH): they are single-key outputs whose key is public. The `022` tag keeps them traceable.

## Limitations

- **Siblings first funded after the reveal.** Handled at receipt time: the ETL checks every address
  that receives its first coins against every public key (see *Receipt-time check* below).
- **Keys from spent P2PK and bare-multisig outputs.** The database keeps only unspent outputs, so
  their keys are recovered only by a chain walk (`--phase outkeys`, below). Sampling found almost
  nothing there.

## Receipt-time check

At reveal time the ETL can only mark sibling addresses that already exist. A sibling first funded
later is caught when it is funded: at the end of each block, every address that received its first
coins is checked two ways.

- **Forward.** A P2PKH or P2WPKH address's key hash also gives its other single-key forms (the other
  of the two, and the P2SH-P2WPKH wrapping). If one of them is exposed and its key hashes to this
  address, the address is exposed.
- **Reverse.** `revealed_key_hashes` (migration 009) holds the sibling hashes no address can be
  turned into: the P2SH-P2WPKH wrapping of keys revealed at P2PKH / P2WPKH addresses, the other
  encoding of uncompressed and hybrid keys, and every form of keys seen in scripts, P2PK and
  bare-multisig outputs. It is keyed by the first 8 bytes of the hash; each hit is confirmed by
  re-hashing the stored key.

A reveal before an address's first receipt is caught by this check, a reveal after it by the
marking at reveal time, so no sibling is missed. The address page and `/api/v1/address` run the
same lookup live, so an address can be checked before any coins are sent to it.

## Backfill

`scripts/backfill-quantum-exposure.ts --phase siblings` makes two sequential passes over
`address_info`. The first collects every address not yet exposed; the second derives the siblings
of every known key and matches them against the first set in memory. Only matches touch the
database. P2PK and bare-multisig keys are read from `utxos`.

Run on 2026-10-26/27 (about 4 hours): 54,463 addresses marked, all funded, 239,021 UTXOs and
2,386 BTC tagged. The largest single case is a wallet migration: `1D58NtxrZF4iUnGAFojnqNpPuGi9rrcyVf`
spent 519.70 BTC at block 501886, revealing its uncompressed key, and the coins went to the same
key's compressed address `1LRHPN36YQufar8gH4au2evXLeD5ddPJwY`, where they still sit.

How each marked address relates to the key's source, which decides how it can be caught later:

| Relation | Addresses | BTC |
|----------|-----------|-----|
| Same HASH160, P2PKH ↔ P2WPKH, or wrapped source → P2PKH / P2WPKH | 9,737 | 988 |
| Same HASH160, new address is P2SH-P2WPKH | 3,930 | 518 |
| Other encoding (uncompressed → compressed), or key from a script / P2PK / P2MS | 40,779 | 880 |

`--phase outkeys` adds keys from P2PK and bare-multisig outputs that are already spent, by walking
every block's outputs over RPC. Samples across all eras found almost nothing beyond `siblings`
(0.003 BTC in the first 3,000 blocks, nothing elsewhere), so the full two-day walk was not run.

## Relationship to Other Proposals

| Proposal | Where the key appears               | Addresses exposed         |
|----------|-------------------------------------|---------------------------|
| 015 / 020| in the output script                | that output               |
| 016      | in the spending input (one key)     | the spent address         |
| 021      | in the spending input (a script)    | the spent address         |
| 022      | any of the above                    | every single-key address of the same key |
