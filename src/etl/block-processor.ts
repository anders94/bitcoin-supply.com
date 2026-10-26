import { upsertBlock } from '../db/blocks.js';
import { insertUtxo, deleteUtxo, markAddressPubkeyExposed as markUtxosPubkey, flagUtxoExposed } from '../db/utxos.js';
import { upsertAddressInfo, markAddressPubkeyExposed as markAddrPubkey, markAddressKeyInScript, markSiblingAddresses } from '../db/address-info.js';
import { classifyOutput, ClassifierInput } from '../classifiers/index.js';
import { NumsMatcher, EMPTY_NUMS_MATCHER } from '../classifiers/nums.js';
import { exposedKeysInOutput, revealedKeysFromInput, exposureRule, Exposure } from '../classifiers/exposure.js';
import { pool } from '../db/index.js';

// Bitcoin block subsidy schedule
export function calculateSubsidy(blockNumber: number): bigint {
  const halvings = Math.floor(blockNumber / 210_000);
  if (halvings >= 64) return 0n;
  return 5_000_000_000n >> BigInt(halvings); // 50 BTC in sats >> halvings
}

export async function processBlock(
  block: any,
  knownBurnAddresses: Set<string>,
  numsMatcher: NumsMatcher = EMPTY_NUMS_MATCHER
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const blockTimestamp = new Date(block.time * 1000);
    const blockNumber: number = block.height;

    // Calculate supply for this block
    let totalFees = 0n;
    let coinbaseValueSats = 0n;

    // First pass: collect coinbase value and fees
    for (const tx of block.tx) {
      if (tx.vin[0]?.coinbase !== undefined) {
        // Coinbase tx - sum outputs
        for (const vout of tx.vout) {
          coinbaseValueSats += BigInt(Math.round(vout.value * 1e8));
        }
      } else {
        // Regular tx - fee is implicit (inputs - outputs from prevout data)
        let inputSum = 0n;
        let outputSum = 0n;
        for (const vin of tx.vin) {
          if (vin.prevout) inputSum += BigInt(Math.round(vin.prevout.value * 1e8));
        }
        for (const vout of tx.vout) {
          outputSum += BigInt(Math.round(vout.value * 1e8));
        }
        totalFees += inputSum - outputSum;
      }
    }

    const subsidy = calculateSubsidy(blockNumber);
    const allowedSupply = subsidy + totalFees;
    const minerLoss = allowedSupply > coinbaseValueSats ? allowedSupply - coinbaseValueSats : 0n;

    await upsertBlock(client, {
      block_number: blockNumber,
      block_hash: block.hash,
      block_timestamp: blockTimestamp,
      tx_count: block.tx.length,
      coinbase_value_sats: coinbaseValueSats,
      allowed_supply_sats: allowedSupply,
      miner_loss_sats: minerLoss,
    });

    // Addresses whose keys a transaction's inputs reveal (each address once per tx)
    const exposedThisBlock = new Map<string, Exposure>();

    // Second pass: process transactions
    for (const tx of block.tx) {
      const isCoinbase = tx.vin[0]?.coinbase !== undefined;

      // Process INPUTS first (delete spent UTXOs, detect pubkey exposure)
      if (!isCoinbase) {
        for (const vin of tx.vin) {
          if (!vin.txid) continue;

          // Delete the spent UTXO. Decrement address_info only if this delete
          // actually removed a row — a replayed spend (reprocessed block) finds
          // it already gone, and decrementing again would drift the counters.
          const deleted = await deleteUtxo(client, vin.txid, vin.vout);

          if (deleted && vin.prevout?.scriptPubKey?.address) {
            const addr = vin.prevout.scriptPubKey.address;
            const spentSats = BigInt(Math.round(vin.prevout.value * 1e8));
            // Zero-value outputs are never inserted, so a real delete implies
            // value > 0; the guard is belt-and-braces.
            if (spentSats > 0n) {
              await upsertAddressInfo(client, addr, blockNumber, false, spentSats);
            }
          }

          // Detect key exposure: P2PKH / P2WPKH reveal the key (016); P2SH /
          // P2WSH reveal the script and every key in it (021).
          const revealed = revealedKeysFromInput(vin);
          if (revealed && vin.prevout?.scriptPubKey?.address) {
            const addr = vin.prevout.scriptPubKey.address;
            if (!exposedThisBlock.has(addr)) {
              exposedThisBlock.set(addr, revealed);
            }
          }
        }
      }

      // Apply exposure before this tx's outputs are inserted, so change sent
      // back to a just-exposed address is flagged by the receipt path below.
      // Proposal 022: keys revealed here for the first time also expose their
      // other addresses. A reused address's later spends reveal nothing new.
      // Batched per tx: most inputs are first spends of fresh addresses.
      const firstRevealKeys: string[] = [];
      for (const [addr, exp] of exposedThisBlock) {
        const keys = exp.keys.join(',');
        if (await markAddrPubkey(client, addr, keys, blockNumber, exp.kind)) firstRevealKeys.push(...exp.keys);
        await markUtxosPubkey(client, addr, keys, exposureRule(exp.kind));
      }
      await markSiblingAddresses(client, firstRevealKeys, blockNumber);
      exposedThisBlock.clear();

      // Process OUTPUTS (insert new UTXOs)
      for (let i = 0; i < tx.vout.length; i++) {
        const vout = tx.vout[i];
        const scriptHex: string = vout.scriptPubKey.hex || '';
        const scriptType: string = vout.scriptPubKey.type || 'nonstandard';
        const address: string | null = vout.scriptPubKey.address || null;
        const valueSats = BigInt(Math.round(vout.value * 1e8));

        // Zero-value outputs hold no supply, so they are not tracked. This is
        // mostly OP_RETURN data carriers (~59% of all outputs ever created);
        // Bitcoin Core likewise never puts them in the UTXO set. Skipping them
        // here keeps the table to outputs that actually carry coin. The spend
        // path above has the matching guard.
        if (valueSats === 0n) continue;

        const ctx: ClassifierInput = {
          block_number: blockNumber,
          block_timestamp: blockTimestamp,
          tx_hash: tx.txid,
          is_coinbase: isCoinbase,
          output_index: i,
          value_sats: valueSats,
          script_hex: scriptHex,
          script_type: scriptType,
          address: address || undefined,
          knownBurnAddresses,
          numsMatcher,
        };

        const { rules, bucket } = classifyOutput(ctx);

        // Keys in the output script itself (015 P2PK, 019 P2TR, 020 P2MS) are
        // exposed from creation. The rule set already enforces on-curve, so an
        // off-curve "key" (provably lost, no private key exists) is never
        // flagged — the old ETL flagged every P2PK shape regardless. Bucket 4
        // also excludes NUMS keys (018, bucket 2): lost outputs stay out of
        // the quantum lens.
        const inScript = bucket === 4 ? exposedKeysInOutput(scriptHex) : null;

        const inserted = await insertUtxo(client, {
          tx_hash: tx.txid,
          output_index: i,
          value_sats: valueSats,
          block_number: blockNumber,
          block_timestamp: blockTimestamp,
          script_hex: scriptHex,
          script_type: scriptType,
          address,
          loss_rules: rules,
          loss_bucket: bucket,
          pubkey_exposed: inScript !== null,
          pubkey_hex: inScript ? inScript.keys.join(',') : null,
        });

        // Increment address_info only if a row was actually inserted. On a
        // reprocessed block the insert is a no-op (ON CONFLICT), so a blind
        // increment here is exactly what drifted the counters — and left
        // "ghost" balances on fully-spent addresses. Key-in-script marking is
        // idempotent, so it needn't be gated.
        if (address && inserted) {
          const prior = await upsertAddressInfo(client, address, blockNumber, true, valueSats);
          // A receipt at an address whose key(s) are already on-chain is
          // exposed from birth: the key stays public forever, so a coin that
          // lands later is as reachable as one that was there at the spend.
          if (!inScript && prior?.pubkey_exposed) {
            await flagUtxoExposed(
              client, tx.txid, i, blockNumber, prior.pubkey_hex,
              exposureRule(prior.exposure_kind ?? 'pkh')
            );
          }
        }
        if (address && inScript) {
          await markAddressKeyInScript(client, address, inScript.kind, inScript.keys.join(','));
        }
        // Proposal 022: a P2PK or bare-multisig key is public from creation, so
        // its single-key addresses are exposed too. (Taproot output keys are
        // tweaked x-only keys that no single-key address commits to.)
        if (inserted && inScript && inScript.kind !== 'p2tr') {
          await markSiblingAddresses(client, inScript.keys, blockNumber);
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
