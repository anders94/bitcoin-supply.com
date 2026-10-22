# Plan: making the quantum-exposure figure correct

Written 2026-10-13. Context: the homepage reported 3,575,929 BTC exposed while
Project Eleven's Bitcoin Risq List reported 7,105,958 BTC at the same height.
Our P2PK figure matched theirs to within ~460 BTC; the whole gap is in what we
did not count.

| Cause | Approx. BTC | Fix |
|-------|-------------|-----|
| UTXOs received at an address *after* its key was revealed were never flagged (ETL only flagged what existed at spend time) | ~2.3M | Step 1 |
| Taproot (P2TR) never counted; the output key is a curve point in the script | ~0.22M | Step 2 |
| Bare multisig (P2MS) never counted | ~0.0004M | Step 3 |
| P2SH / P2WSH spends reveal the redeem/witness script and therefore every cosigner key; never parsed | ~1.9M | Step 4 |
| Page copy implied the figure was a total | — | Step 5 |

The site's own `/api/v1/quantum` (address-level) already disagreed with the
homepage (UTXO-level): 5,900,844 vs 3,575,929 BTC. Step 1 reconciles them.

## Step 1 — flag receipts at already-exposed addresses

* ETL: `upsertAddressInfo` now returns the address's exposure state on insert.
  When the address is already exposed, the freshly inserted UTXO is flagged
  immediately (`flagUtxoExposed`) with rule 016 (key revealed by a P2PKH/P2WPKH
  spend) or 021 (key revealed by a script spend).
* Backfill phase `receipts`: one `UPDATE … FROM address_info` per partition.
* Also clears the exposed flag on provably-lost (off-curve) P2PK rows, which
  the old ETL flagged although no private key exists for them.

## Step 2 — Proposal 019: Taproot outputs

* Classifier `classifyTaprootKey`: `5120 <32-byte x>` with x on the curve → 019,
  bucket 4. Off-curve x stays with 007 (provably lost). NUMS output keys stay in
  018 (probably lost) by the existing bucket ladder.
* ETL: output key stored as `pubkey_hex`; address kind `p2tr`.
* Backfill phase `p2tr`: pure SQL per partition, then address_info.

## Step 3 — Proposal 020: Bare multisig outputs

* Classifier `classifyBareMultisig`: standard M-of-N script with at least M
  on-curve keys → 020, bucket 4 (fewer than M valid keys is already 006).
* Backfill phase `p2ms`: rows selected by script_type, keys parsed in JS.

## Step 4 — Proposal 021: Keys revealed by script spends

* `revealedKeysFromInput` (src/classifiers/exposure.ts) parses the spending
  input by prevout type: P2PKH/P2WPKH (as before), P2SH-P2WPKH, P2SH, P2WSH,
  P2SH-P2WSH. The revealed script is scanned for on-curve keys.
  * No hash opcodes in the script → kind `script` (key-only conditions).
  * Hash opcodes present (HTLC-style) → kind `script-mixed`: keys are exposed
    but at least one branch needs a preimage. Counted as exposed, reported
    separately on /quantum so the caveat is visible.
* `address_info.exposure_kind` (migration 008) records how the address was
  exposed: p2pk, p2tr, p2ms, pkh, script, script-mixed.
* Backfill phase `scripts`: the database keeps no spent inputs, so this is a
  chain walk over RPC over P2SH/P2WSH inputs, one address lookup per block.
  Every not-yet-exposed address is marked, including empty ones: an address
  emptied before the walk and refilled later must already be known as exposed,
  or the ETL's receipt check cannot flag the new coin. Resumable via etl_state.
  This is the long pole (days).

## Step 5 — Reporting

* Snapshots split by how the key became public: quantum_p2pk, quantum_p2tr,
  quantum_p2ms, quantum_exposed_pkh (incl. P2SH-P2WPKH, rule 016),
  quantum_exposed_script (rule 021), quantum_all_exposed. Only spendable rows
  (buckets 0 / 4) count: provably-lost and NUMS-key (018) rows are excluded
  from every quantum figure.
* Homepage note, /quantum page, address page, API and README state exactly
  what is counted and what the mixed-script caveat means.

## Step 6 — Standing cross-check

* The hourly snapshot job fetches Project Eleven's public metrics endpoint
  (best effort, 15s timeout) and /quantum shows their latest figure next to
  ours with the block height, so divergence is visible without a manual check.

## Rollout order

1. `npm run migrate` (adds address_info.exposure_kind; metadata-only).
2. Deploy ETL + web.
3. `npx tsx scripts/backfill-quantum-exposure.ts --phase fix,receipts,p2tr,p2ms --execute`
   (skip `kinds`: readers already fall back to is_p2pk for NULL kinds, and it
   would rewrite ~1.3B address_info rows)
4. `npx tsx scripts/backfill-quantum-exposure.ts --phase scripts --execute`
   (chain walk; resumable; run until it reaches the block the new ETL started at).
5. `npm run snapshot`, then compare /quantum against the Project Eleven line.

Expected result after 3: ≈ 6.1M BTC. After 4: within a few tens of thousands
of BTC of Project Eleven, the residue being their P2PK/P2PKH address ambiguity.
