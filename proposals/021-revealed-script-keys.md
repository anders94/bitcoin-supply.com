# Proposal 021: Keys Revealed by Script Spends — Quantum Vulnerable

| Field               | Value             |
|---------------------|-------------------|
| Author              | Anders Brownworth |
| Status              | Draft             |
| Created             | 2026-10-13        |
| Category            | Quantum Vulnerable|
| Scale Estimate      | ~1.9M BTC         |

## Problem

Pay-to-Script-Hash (P2SH) and Pay-to-Witness-Script-Hash (P2WSH) outputs commit to a script by
its hash. Spending one publishes the script — the *redeemScript* (last push of the scriptSig)
or the *witnessScript* (last witness element) — and with it every public key the script
contains. For the multisig scripts that hold most of this value, that is every cosigner key.

Once published, those keys are public forever. Any coins still at the same address, and any
coins sent to it afterwards, can be swept by a quantum attacker who derives M of the N private
keys. This is Proposal 016's mechanism generalised from one key to a script's worth of keys,
and it is where exchange cold storage lives: the largest balances on-chain are reused P2SH and
P2WSH multisig addresses.

## Detection

At spend time, by the previous output's type:

| Prevout type           | Script revealed in                                 |
|------------------------|----------------------------------------------------|
| `scripthash`           | last scriptSig push (redeemScript)                 |
| `scripthash` → `0014…` | P2SH-P2WPKH: key is `witness[1]` → **Proposal 016** |
| `scripthash` → `0020…` | P2SH-P2WSH: last witness element (witnessScript)   |
| `witness_v0_scripthash`| last witness element (witnessScript)               |

The revealed script is parsed into pushes and opcodes. Every 33- or 65-byte push that is a
valid curve point is a revealed key. If none is found nothing is tagged.

```typescript
const keys = pushes.filter(isValidPubkey);
const mixed = opcodes.some(op => HASH_OPCODES.has(op)); // RIPEMD160 SHA1 SHA256 HASH160 HASH256
kind = mixed ? 'script-mixed' : 'script';
```

Then, exactly as in 016, every remaining UTXO at the address is tagged and later receipts are
tagged on arrival:

```sql
UPDATE utxos SET pubkey_exposed = TRUE, pubkey_hex = $keys,
  loss_rules = array_append(loss_rules, '021')   -- bucket 0 rows only
WHERE address = $1 AND pubkey_exposed = FALSE AND loss_bucket <> 1
```

## Classification

Loss bucket: **4** (Quantum only) for UTXOs with no other loss classification.

`address_info.exposure_kind` records `script` or `script-mixed`:

- **script** — every spending condition is a signature (optionally behind a timelock).
  Plain M-of-N multisig, timelocked keys, Lightning funding outputs.
- **script-mixed** — the script also applies a hash opcode to stack input, so at least one
  branch needs a preimage (HTLCs, atomic swaps). The keys are nonetheless public. In the
  overwhelmingly common pattern the preimage branch is paired with a timeout branch that needs
  only a signature, so an attacker who can wait can spend. These outputs are counted as exposed
  and broken out separately on the quantum page so the caveat stays visible.

## What is not tagged

- P2PK, P2TR and bare multisig prevouts: nothing new is revealed (015 / 019 / 020).
- Taproot script-path spends: the output key was already exposed on creation (019).
- Revealed scripts with no on-curve key pushes (hash puzzles, OP_TRUE wrappers).
- Nonstandard prevouts.

## Backfill

The database keeps only the live UTXO set, not spent inputs, so historical script reveals must
be recovered by walking the chain. `scripts/backfill-quantum-exposure.ts --phase scripts` does
this over RPC, considering only P2SH / P2WSH inputs whose address still holds a balance, and is
resumable via `etl_state`.

## Relationship to Proposals 016 and 019

| Proposal | Where the key appears              | When exposed  |
|----------|------------------------------------|---------------|
| 015 / 019 / 020 | in the output script         | at creation   |
| 016      | in the spending input (one key)    | at first spend|
| 021      | in the spending input (a script)   | at first spend|
