import { config } from '../config.js';

// Minimal JSON-RPC client for bitcoind. Replaces the bitcoin-core package,
// whose dependency tree (request, form-data, tough-cookie) is unmaintained
// and flagged by npm audit.

const rpcUrl = `http://${config.rpc.host}:${config.rpc.port}/`;
const authHeader =
  'Basic ' +
  Buffer.from(`${config.rpc.username}:${config.rpc.password}`).toString('base64');

let nextId = 0;

async function rpc(method: string, params: any[] = []): Promise<any> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify({ jsonrpc: '1.0', id: ++nextId, method, params }),
  });

  // bitcoind returns JSON-RPC errors with non-200 status codes but still a
  // JSON body — prefer the RPC error message when one is present.
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`RPC ${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  if (body.error) {
    throw new Error(`RPC ${method}: ${body.error.message} (code ${body.error.code})`);
  }
  return body.result;
}

export async function getBlockHash(height: number): Promise<string> {
  return rpc('getblockhash', [height]);
}

export async function getBlock(hash: string): Promise<any> {
  return rpc('getblock', [hash, 3]);
}

export async function getBlockCount(): Promise<number> {
  return rpc('getblockcount');
}

export async function getRawTransaction(txid: string): Promise<any> {
  return rpc('getrawtransaction', [txid, true]);
}

// Fetch multiple blocks in parallel
export async function getBlocks(hashes: string[]): Promise<any[]> {
  return Promise.all(hashes.map(h => getBlock(h)));
}
