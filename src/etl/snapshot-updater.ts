import { pool } from '../db/index.js';
import { upsertSnapshot } from '../db/snapshots.js';

export async function updateSnapshots(): Promise<void> {
  const { rows: tipRows } = await pool.query('SELECT MAX(block_number) n FROM blocks');
  const tipBlock: number = tipRows[0].n ?? 0;

  // Provably lost
  const { rows: provably } = await pool.query(
    `SELECT COALESCE(SUM(value_sats), 0) total_sats, COUNT(*) utxo_count
     FROM utxos WHERE loss_bucket = 1`
  );
  await upsertSnapshot({ snapshot_key: 'provably_lost', total_sats: BigInt(provably[0].total_sats), utxo_count: BigInt(provably[0].utxo_count), computed_at_block: tipBlock });

  // Probably lost (bucket 1 + 2)
  const { rows: probably } = await pool.query(
    `SELECT COALESCE(SUM(value_sats), 0) total_sats, COUNT(*) utxo_count
     FROM utxos WHERE loss_bucket IN (1, 2)`
  );
  await upsertSnapshot({ snapshot_key: 'probably_lost', total_sats: BigInt(probably[0].total_sats), utxo_count: BigInt(probably[0].utxo_count), computed_at_block: tipBlock });

  // All UTXOs
  const { rows: allUtxos } = await pool.query(
    `SELECT COALESCE(SUM(value_sats), 0) total_sats, COUNT(*) utxo_count FROM utxos`
  );
  await upsertSnapshot({ snapshot_key: 'all_utxos', total_sats: BigInt(allUtxos[0].total_sats), utxo_count: BigInt(allUtxos[0].utxo_count), computed_at_block: tipBlock });

  // Dormancy breakpoints
  const { rows: tipTimeRows } = await pool.query(
    'SELECT block_timestamp FROM blocks WHERE block_number = $1', [tipBlock]
  );
  if (!tipTimeRows.length) return;

  const tipDate = new Date(tipTimeRows[0].block_timestamp);

  for (const years of [1, 3, 5, 7, 10, 15, 20]) {
    const cutoff = new Date(tipDate);
    cutoff.setFullYear(cutoff.getFullYear() - years);

    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(value_sats), 0) total_sats, COUNT(*) utxo_count
       FROM utxos WHERE loss_bucket = 0 AND block_timestamp <= $1`,
      [cutoff]
    );
    await upsertSnapshot({ snapshot_key: `dormant_${years}y`, total_sats: BigInt(rows[0].total_sats), utxo_count: BigInt(rows[0].utxo_count), computed_at_block: tipBlock });
  }

  // Quantum stats
  const { rows: qp2pk } = await pool.query(
    `SELECT COALESCE(SUM(value_sats), 0) total_sats, COUNT(*) utxo_count
     FROM utxos WHERE loss_rules @> '{015}'`
  );
  await upsertSnapshot({ snapshot_key: 'quantum_p2pk', total_sats: BigInt(qp2pk[0].total_sats), utxo_count: BigInt(qp2pk[0].utxo_count), computed_at_block: tipBlock });

  const { rows: qall } = await pool.query(
    `SELECT COALESCE(SUM(value_sats), 0) total_sats, COUNT(*) utxo_count
     FROM utxos WHERE pubkey_exposed = TRUE`
  );
  await upsertSnapshot({ snapshot_key: 'quantum_all_exposed', total_sats: BigInt(qall[0].total_sats), utxo_count: BigInt(qall[0].utxo_count), computed_at_block: tipBlock });

  console.log(`Snapshots updated at block ${tipBlock}`);
}
