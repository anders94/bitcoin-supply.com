# Proposal 022: Key Reuse Across Address Types — Quantum Vulnerable

| Field               | Value             |
|---------------------|-------------------|
| Author              | Anders Brownworth |
| Status              | Draft             |
| Created             | 2026-10-26        |
| Category            | Quantum Vulnerable|
| Scale Estimate      | ~2,000–3,000 BTC  |

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

## Classification

Loss bucket: **4** (Quantum only) for UTXOs with no other loss classification.

On the quantum page these coins count in the "key revealed by a spend" category (P2PKH / P2WPKH /
P2SH-P2WPKH): they are single-key outputs whose key is public. The `022` tag keeps them traceable.

## Limitations

- **Siblings first funded after the reveal.** The ETL marks sibling addresses it already knows. An
  address that receives its first coins after its key was revealed elsewhere is not caught, because
  there was no row to mark at reveal time. Catching it would mean indexing every known key's
  HASH160 (several billion entries). Re-running the backfill sweep picks these up.
- **Keys from spent P2PK and bare-multisig outputs.** The database keeps only unspent outputs, so
  their keys are recovered only by a chain walk (a separate, optional backfill).

## Backfill

`scripts/backfill-quantum-exposure.ts --phase siblings` makes two sequential passes over
`address_info`. The first collects every address not yet exposed; the second derives the siblings
of every known key and matches them against the first set in memory. Only matches touch the
database. P2PK and bare-multisig keys are read from `utxos`.

## Relationship to Other Proposals

| Proposal | Where the key appears               | Addresses exposed         |
|----------|-------------------------------------|---------------------------|
| 015 / 020| in the output script                | that output               |
| 016      | in the spending input (one key)     | the spent address         |
| 021      | in the spending input (a script)    | the spent address         |
| 022      | any of the above                    | every single-key address of the same key |
