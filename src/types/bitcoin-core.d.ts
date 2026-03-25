declare module 'bitcoin-core' {
  interface BitcoinCoreOptions {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    network?: string;
  }

  class Client {
    constructor(options: BitcoinCoreOptions);
    getBlockHash(height: number): Promise<string>;
    getBlock(hash: string, verbosity?: number): Promise<any>;
    getBlockCount(): Promise<number>;
    getRawTransaction(txid: string, verbose?: boolean): Promise<any>;
  }

  export = Client;
}
