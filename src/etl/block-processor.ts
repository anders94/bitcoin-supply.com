import { upsertBlock } from '../db/blocks.js';
import { insertUtxo, deleteUtxo, markAddressPubkeyExposed as markUtxosPubkey } from '../db/utxos.js';
import { upsertAddressInfo, markAddressPubkeyExposed as markAddrPubkey } from '../db/address-info.js';
import { classifyOutput, ClassifierInput } from '../classifiers/index.js';
import { pool } from '../db/index.js';

// Bitcoin block subsidy schedule
export function calculateSubsidy(blockNumber: number): bigint {
  const halvings = Math.floor(blockNumber / 210_000);
  if (halvings >= 64) return 0n;
  return 5_000_000_000n >> BigInt(halvings); // 50 BTC in sats >> halvings
}

export async function processBlock(block: any, knownBurnAddresses: Set<string>): Promise<void> {
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

    // Track addresses whose pubkeys are exposed this block (process each address only once)
    const exposedThisBlock = new Map<string, string>(); // address -> pubkeyHex

    // Second pass: process transactions
    for (const tx of block.tx) {
      const isCoinbase = tx.vin[0]?.coinbase !== undefined;

      // Process INPUTS first (delete spent UTXOs, detect pubkey exposure)
      if (!isCoinbase) {
        for (const vin of tx.vin) {
          if (!vin.txid) continue;

          // Delete the spent UTXO
          await deleteUtxo(client, vin.txid, vin.vout);

          // Update address activity
          if (vin.prevout?.scriptPubKey?.address) {
            const addr = vin.prevout.scriptPubKey.address;
            const spentSats = BigInt(Math.round(vin.prevout.value * 1e8));
            await upsertAddressInfo(client, addr, blockNumber, false, spentSats);
          }

          // Detect pubkey exposure
          const pubkey = extractPubkeyFromInput(vin);
          if (pubkey && vin.prevout?.scriptPubKey?.address) {
            const addr = vin.prevout.scriptPubKey.address;
            if (!exposedThisBlock.has(addr)) {
              exposedThisBlock.set(addr, pubkey);
            }
          }
        }
      }

      // Apply pubkey exposure updates for this block
      for (const [addr, pubkey] of exposedThisBlock) {
        await markAddrPubkey(client, addr, pubkey, blockNumber);
        await markUtxosPubkey(client, addr, pubkey);
      }
      exposedThisBlock.clear();

      // Process OUTPUTS (insert new UTXOs)
      for (let i = 0; i < tx.vout.length; i++) {
        const vout = tx.vout[i];
        const scriptHex: string = vout.scriptPubKey.hex || '';
        const scriptType: string = vout.scriptPubKey.type || 'nonstandard';
        const address: string | null = vout.scriptPubKey.address || null;
        const valueSats = BigInt(Math.round(vout.value * 1e8));

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
        };

        const { rules, bucket } = classifyOutput(ctx);

        // P2PK outputs have the pubkey in the script itself
        const p2pkPubkey = extractP2PKPubkey(scriptHex);

        await insertUtxo(client, {
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
          pubkey_exposed: p2pkPubkey !== null,
          pubkey_hex: p2pkPubkey,
        });

        if (address) {
          await upsertAddressInfo(client, address, blockNumber, true, valueSats);
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

function extractPubkeyFromInput(vin: any): string | null {
  // P2PKH scriptSig: "<sig> <pubkey>" — last token is pubkey
  if (vin.scriptSig?.asm) {
    const parts = vin.scriptSig.asm.split(' ');
    const last = parts[parts.length - 1];
    if (last && (last.length === 66 || last.length === 130) && !last.startsWith('OP_')) {
      return last;
    }
  }
  // P2WPKH witness: [sig, pubkey]
  if (vin.txinwitness && vin.txinwitness.length === 2) {
    const pubkey = vin.txinwitness[1];
    if (pubkey && (pubkey.length === 66 || pubkey.length === 130)) {
      return pubkey;
    }
  }
  return null;
}

function extractP2PKPubkey(scriptHex: string): string | null {
  // Uncompressed P2PK: 41 + pubkey(130 chars) + ac
  if (scriptHex.length === 134 && scriptHex.startsWith('41') && scriptHex.endsWith('ac')) {
    return scriptHex.slice(2, 132);
  }
  // Compressed P2PK: 21 + pubkey(66 chars) + ac
  if (scriptHex.length === 70 && scriptHex.startsWith('21') && scriptHex.endsWith('ac')) {
    return scriptHex.slice(2, 68);
  }
  return null;
}
