# bitcoin supply explorer v2

A Bitcoin supply explorer that answers: *"If you believe coins are lost after X years of dormancy, how much bitcoin is actually circulating?"*

The interface presents a spectrum from **everything out of circulation** (absurdly inclusive — every UTXO) to **nothing out of circulation** (trustfully inclusive — even provably unspendable coins might somehow be claimed). A separate quantum slider shows how much BTC a rational attacker could capture by targeting the largest exposed-pubkey outputs first.

---

## Architecture

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22+ / TypeScript |
| Bitcoin data | Bitcoin Core JSON-RPC verbosity=3 + ZMQ |
| Database | PostgreSQL 16+ (partitioned UTXO table) |
| Cache | Redis 7+ |
| Web framework | Express + Pug (SSR) |
| Frontend | Vanilla TypeScript via esbuild |
| Sliders | noUiSlider |
| Charts | Chart.js v4 |

### Why verbosity=3 directly

`getblock(hash, 3)` returns a single JSON response with full decoded inputs (including `prevout.value` and `prevout.scriptPubKey` for every input) and outputs. This eliminates the need for a separate UTXO lookup during ingestion — Bitcoin Core handles it. One round-trip per block.

### UTXO table design

- Rows **deleted** when outputs are spent (not flagged). The table always reflects the live UTXO set.
- Partitioned by `block_number` into halving epochs (0–210k, 210k–420k, …).
- `block_timestamp` is denormalized into every UTXO row so dormancy queries can use a plain index scan without joining to `blocks`.
- `loss_bucket` is **never 3** — dormancy is computed at query time via `block_timestamp`, never stored.
- `loss_rules TEXT[]` with GIN index records which proposals matched each output.

### Loss buckets

| Bucket | Meaning |
|--------|---------|
| 0 | Unclassified (normal UTXO) |
| 1 | Provably lost (mathematically unspendable) |
| 2 | Probably lost (known burn addresses, OP_TRUE ACS) |
| 4 | Quantum-tagged (valid P2PK or exposed-pubkey P2PKH — not lost, but at risk) |
| *(3)* | Dormant — never stored; computed at query time via `block_timestamp <= cutoff` |

---

## Requirements

- **Bitcoin Core** (mainnet, fully synced, unpruned, `txindex=true`, verbosity=3 working)
- **ZMQ** enabled with `sequence` topic (`-zmqpubsequence=tcp://0.0.0.0:28332`)
- **PostgreSQL 16+**
- **Redis 7+**
- **Node.js 22+**

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your Bitcoin Core RPC credentials, PostgreSQL, and Redis config
```

Key variables:

```env
RPCHOST=localhost
RPCPORT=8332
RPCUSERNAME=bitcoin
RPCPASSWORD=your_rpc_password_here
RPCNETWORK=mainnet
ZMQADDRESS=tcp://localhost:28332

PGHOST=localhost
PGPORT=5432
PGDATABASE=bitcoin_supply
PGUSER=bitcoin_supply
PGPASSWORD=your_db_password_here

REDISHOST=127.0.0.1
REDISPORT=6379

ETL_CONCURRENCY=8      # parallel RPC connections for historical sync
ETL_BATCH_SIZE=1000    # blocks per DB transaction checkpoint
```

### 3. Run database migrations

```bash
# Apply schema and seed data
PGHOST=127.0.0.1 PGUSER=... PGPASSWORD=... PGDATABASE=... \
  psql -f migrations/001-initial-schema.sql
  psql -f migrations/001-seed-data.sql

# Or use the built-in migration runner:
npm run migrate
```

### 4. Build

```bash
npm run build      # compiles TypeScript + bundles frontend JS via esbuild
```

---

## Running

### Historical sync (first run — ~3 hours with 8 concurrent connections)

```bash
nohup node dist/etl/index.js historical > /tmp/bitcoin-etl.log 2>&1 &
tail -f /tmp/bitcoin-etl.log
```

The ETL checkpoints every 1000 blocks. If interrupted, it resumes from the last checkpoint stored in `etl_state`.

### Compute loss snapshots (after historical sync, then hourly)

```bash
node dist/etl/index.js snapshot
```

This populates `loss_snapshots` with pre-computed totals for each slider stop (provably lost, probably lost, dormant 1/3/5/7/10/15/20 years, quantum totals). The web server's stats and dormancy-curve endpoints serve these cached values.

### Live sync (after historical sync completes)

```bash
node dist/etl/index.js live
```

Subscribes to the Bitcoin Core ZMQ `sequence` topic. On each new block, processes it and broadcasts an SSE event to connected browsers. Also runs the snapshot updater hourly.

### Web server

```bash
node dist/server.js        # production
npm run dev                # development (tsx watch, no compile step)
```

Serves on port 3000 (configurable via `PORT` env var).

---

## ETL internals

### Block processing pipeline

For each block (`getblock(hash, 3)`):

1. **Inputs first** — delete the spent UTXO rows, detect pubkey exposure from `scriptSig.asm` (P2PKH) or `txinwitness[1]` (P2WPKH). When a pubkey is revealed, retroactively mark all remaining UTXOs of that address as `pubkey_exposed = TRUE`.
2. **Outputs second** — classify each output through the classifier pipeline, insert as a new UTXO row.

Processing inputs before outputs in each block maintains UTXO set consistency even when a transaction spends and creates outputs to the same address.

### Pubkey exposure

When a P2PKH or P2WPKH output is spent, the pubkey is revealed in the scriptSig or witness. The ETL:
- Updates `address_info.pubkey_hex` and `pubkey_exposed_at_block`
- Updates all remaining UTXOs for that address: `pubkey_exposed = TRUE`

This means the quantum slider accurately reflects the current exposure state, not just the creation-time state.

---

## Classifier proposals

Each output is run through the full classifier pipeline. Results are aggregated into `loss_rules[]` and `loss_bucket`.

| ID | Category | Description |
|----|----------|-------------|
| 000 | Provably Lost | Block 0 coinbase (unspendable by consensus) |
| 001 | Provably Lost | Duplicate coinbase txid (blocks 91722 / 91812) |
| 002 | *(Block-level)* | Miner underclaim — tracked in `blocks.miner_loss_sats`, not UTXOs |
| 003 | Provably Lost | Mt. Gox error script (`76a90088ac`) |
| 004 | Provably Lost | OP_RETURN outputs |
| 005 | Provably Lost | P2PK with off-curve public key |
| 006 | Provably Lost | Multisig with insufficient valid (on-curve) keys |
| 007 | Provably Lost | Taproot with invalid x-only key |
| 008 | Provably Lost | SegWit v0 with wrong witness program length |
| 009 | Provably Lost | P2PKH/P2SH with wrong hash push length |
| 010 | Provably Lost | P2PK with invalid key length or prefix byte |
| 011 | Provably Lost | Script containing OP_VERIF / OP_VERNOTIF (abort opcode) |
| 012 | Probably Lost | Known vanity burn addresses |
| 013 | Probably Lost | OP_TRUE (anyone-can-spend) outputs dormant 3+ years |
| 014 | *(Methodology)* | Dormancy methodology — no ETL detection, computed at query time |
| 015 | Quantum | Valid P2PK output (pubkey in script, always exposed) |
| 016 | Quantum | P2PKH/P2WPKH where a prior spend has revealed the pubkey |
| 017 | *(Research)* | Satoshi-era (Patoshi-pattern) coinbases — optional toggle |

The secp256k1 math (on-curve checks, multisig parsing, abort opcode detection) is ported verbatim from the original `detectors/index.js` with no logic changes.

---

## API endpoints

All endpoints served under `/api/v1/`.

| Endpoint | Cache | Description |
|----------|-------|-------------|
| `GET /stats` | 60s | Circulating supply, block tip, provably/probably/quantum totals |
| `GET /loss-spectrum` | 5min | Slider query — total sats out-of-circulation at given threshold |
| `GET /dormancy-curve` | 10min | Pre-computed breakpoints for dormancy slider (1–20 years) |
| `GET /loss-breakdown` | 5min | Per-proposal totals from `unnest(loss_rules)` |
| `GET /quantum` | 5min | P2PK totals, exposed-PKH totals, top addresses |
| `GET /quantum-curve` | 10min | Cumulative curve sorted by value DESC (for quantum slider) |
| `GET /concentration` | 5min | Top addresses by total UTXO value |
| `GET /events` | — | SSE stream — live block events |

**`/loss-spectrum` parameters:**
- `max_bucket=1` — provably lost only
- `max_bucket=2` — provably + probably lost
- `max_bucket=3&dormant_before=<ISO date>` — provably + probably + dormant since date
- `include_quantum=true` — add quantum overlay to any of the above

---

## Pages

| Route | Description |
|-------|-------------|
| `/` | Homepage — spectrum slider + quantum slider |
| `/quantum` | Full quantum explorer with exposure table and histogram |
| `/losses` | Paginated loss event history, filterable by proposal |
| `/proposals` | Proposal index |
| `/proposals/:id` | Single proposal (renders markdown) |
| `/address/:addr` | Address detail — UTXOs, quantum status, dormancy |
| `/block/:n` | Block detail |
| `/transaction/:hash` | Transaction detail |
| `/search` | Search by block number, txid, or address |

---

## Database schema overview

```
blocks            — one row per processed block; supply accounting
utxos             — live UTXO set (partitioned by block_number)
address_info      — one row per address; pubkey exposure tracking
loss_snapshots    — pre-computed slider breakpoints (updated hourly)
known_burn_addresses — seeded vanity burn addresses (proposal 012)
etl_state         — ETL checkpoint and mode tracking
```

---

## Verification checklist

After historical sync completes, verify:

- `SELECT SUM(value_sats) FROM utxos WHERE loss_bucket = 1` ≈ known provably-lost total (~3,000 BTC)
- Per-proposal via `unnest`: block 0 = 5,000,000,000 sats; Mt. Gox = ~2,609 BTC
- Dormancy curve is monotonically decreasing: `dormant_20y` < `dormant_15y` < … < `dormant_1y`
- All `script_type = 'pubkey'` UTXOs have `loss_rules @> '{015}'` and `pubkey_exposed = TRUE`
- SSE: browser receives block events within ~1s of a new block
- API endpoints: < 200ms with warm Redis cache
