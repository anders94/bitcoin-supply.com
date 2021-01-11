const BitcoinClient = require('bitcoin-core');
const config = require('./config');
const util = require('util');

const rpc = new BitcoinClient(config.bitcoinRPC);

const main = async () => {
    //const info = await rpc.getBlockchainInfo();
    //const hash = await rpc.getBestBlockHash();
    //const block = await rpc.getBlock(hash);
    const hash = await rpc.getBlockHash(124724)
    const block = await rpc.getBlock(hash, 2);
    //const txHex = await rpc.getRawTransaction('139c004f477101c468767983536caaeef568613fab9c2ed9237521f5ff530afd');
    //const tx = await rpc.decodeRawTransaction(txHex);

    console.log(util.inspect(block, {depth:6}));
}

main();
