import Client from 'bitcoin-core';
import { config } from '../config.js';

const client = new Client({
  host: config.rpc.host,
  port: config.rpc.port,
  username: config.rpc.username,
  password: config.rpc.password,
  network: config.rpc.network,
});

export async function getBlockHash(height: number): Promise<string> {
  return client.getBlockHash(height);
}

export async function getBlock(hash: string): Promise<any> {
  return client.getBlock(hash, 3);
}

export async function getBlockCount(): Promise<number> {
  return client.getBlockCount();
}

export async function getRawTransaction(txid: string): Promise<any> {
  return client.getRawTransaction(txid, true);
}

// Fetch multiple blocks in parallel
export async function getBlocks(hashes: string[]): Promise<any[]> {
  return Promise.all(hashes.map(h => getBlock(h)));
}
