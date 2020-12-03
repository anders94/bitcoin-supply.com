# bitcoin-core by example
The `bitcoin-core` node.js module allows node.js apps to interact with the standard bitcoin RPCs.

## Install
You've done it a million times before.

```
npm install bitcoin-core
```

## Usage
This is some basic boilerplate that should get you up and going.

```
const BitcoinClient = require('bitcoin-core');

const rpc = new BitcoinClient({
    host: '127.0.0.1',
    port: 8332,
    network: 'mainnet',
    username: 'rpcuser',
    password: 'super-secret-password'
});

const main = async () => {
    const info = await rpc.getBlockchainInfo();
    console.log(info);
}

main();
```

## RPC Commands
The following is a select list of all the RPC commands. For the complete list, see https://developer.bitcoin.org/reference/rpc/.

### rpc.getBlockchainInfo()
```
{
  chain: 'main',
  blocks: 658618,
  headers: 658618,
  bestblockhash: '00000000000000000001b322dd591e16b7baa1cdf843ce6b0cf795bfbb12217a',
  difficulty: '17596801059571.43',
  mediantime: 1606314496,
  verificationprogress: '0.999993014672708',
  initialblockdownload: false,
  chainwork: '000000000000000000000000000000000000000016288c839a7945cac026ecfe',
  size_on_disk: 354600230963,
  pruned: false,
  softforks: {
    bip34: { type: 'buried', active: true, height: 227931 },
    bip66: { type: 'buried', active: true, height: 363725 },
    bip65: { type: 'buried', active: true, height: 388381 },
    csv: { type: 'buried', active: true, height: 419328 },
    segwit: { type: 'buried', active: true, height: 481824 }
  }
}
```

### rpc.getBestBlockHash()
```
0000000000000000000bb49b8946267754597c4699672be009f1a59facfa8719
```

### rpc.getBlockHash(657282)
```
00000000000000000000c5c00b60f890efd2f1019ab20c761182f6204d582a69
```

### rpc.getBlock('0000000000000000000c77e3c94b127da437dd567ef2b02c6e008e119f09fe69')
```
{
  hash: '0000000000000000000c77e3c94b127da437dd567ef2b02c6e008e119f09fe69',
  confirmations: 1,
  strippedsize: 924061,
  size: 1226516,
  weight: 3998699,
  height: 658624,
  version: 549453824,
  versionHex: '20c00000',
  merkleroot: 'db44a9bdd627ce7f7a1a2db59f61f8a61ac04a08062e761f9c88caa0d65af512',
  tx: [
    'e5208bb2343db4a2459824969f2e7a5859fc2168d103dff6be7bd4e189bc4a4a',
    'ef6103317d30922ec0940a55302121ebc6eefa6819ce04bb4a9e868940044c31',
    'fd9a0058fe716f9ed5519cecd530125cb0b1369d0312ca0fb0bd9df818d9184c',
    '0b0ab2b7c38f2ebb3c16c481542096b924a332ca9c0ef5f3a5cd3b854d988b84',
    ... lots more items
  ],
  time: 1606319905,
  mediantime: 1606318631,
  nonce: 3393324193,
  bits: '170ffedd',
  difficulty: '17596801059571.43',
  chainwork: '00000000000000000000000000000000000000001628ec8a6cf559fb6f5c5f9a',
  nTx: 2652,
  previousblockhash: '00000000000000000006477ae41a616b8376b92880f3d5d89e29bd7c38994437'
}
```

### rpc.getRawTransaction(32d67023fe5aeea2ec0408824de7d7a9fb887cdf8e50aa75f9304c56eb33a2a3)
```
010000000202deda194136babba285c53274fe43d50ba9e05abe00dd39026629bff7e41035020000006a47304402205b8ff289f80cece269ff2f1487ca6a851168e15e9ae997e51c8a09cbb5a641bb02204e29729b8c10d2802d45b09bbb62cb000071f86b1e57089eb7dd2d4e7e6a50f5012103050c2501cd83c341ad04992db1c42a851e03fd8533533ed0e75bc57cf667997bffffffffbf3ce3bc4335f577d611337d676273863f59a58bcf229326c31cdf671178dba5030000006a47304402207c294be38df814f0c6e5b74c1cfe86a00dfc853369549abc35d3218e05621cc8022023591343b6935599440b598279fd3bcf797f7ae31d25fe3f5c9ec80ec7fae4c0012103050c2501cd83c341ad04992db1c42a851e03fd8533533ed0e75bc57cf667997bffffffff040000000000000000306a2e696424e7aeccf1c8bfc8814c90909288b0704200000000000000000000000000535441434b530000007fcfa688cc7c150000000000001976a914001b33217740dce0064dee7a9c149f016e407b3588ac23020000000000001976a914f9b1ed868503c78825cb636051d9b8d75ec561a988ac3a360000000000001976a914f9b1ed868503c78825cb636051d9b8d75ec561a988ac00000000
```

### rpc.decodeRawTransaction('010000000202deda194136babba285c53274fe43d50ba9e05abe00dd39026629bff7e41035020000006a47304402205b8ff289f80cece269ff2f1487ca6a851168e15e9ae997e51c8a09cbb5a641bb02204e29729b8c10d2802d45b09bbb62cb000071f86b1e57089eb7dd2d4e7e6a50f5012103050c2501cd83c341ad04992db1c42a851e03fd8533533ed0e75bc57cf667997bffffffffbf3ce3bc4335f577d611337d676273863f59a58bcf229326c31cdf671178dba5030000006a47304402207c294be38df814f0c6e5b74c1cfe86a00dfc853369549abc35d3218e05621cc8022023591343b6935599440b598279fd3bcf797f7ae31d25fe3f5c9ec80ec7fae4c0012103050c2501cd83c341ad04992db1c42a851e03fd8533533ed0e75bc57cf667997bffffffff040000000000000000306a2e696424e7aeccf1c8bfc8814c90909288b0704200000000000000000000000000535441434b530000007fcfa688cc7c150000000000001976a914001b33217740dce0064dee7a9c149f016e407b3588ac23020000000000001976a914f9b1ed868503c78825cb636051d9b8d75ec561a988ac3a360000000000001976a914f9b1ed868503c78825cb636051d9b8d75ec561a988ac00000000');
```
{
  txid: '32d67023fe5aeea2ec0408824de7d7a9fb887cdf8e50aa75f9304c56eb33a2a3',
  hash: '32d67023fe5aeea2ec0408824de7d7a9fb887cdf8e50aa75f9304c56eb33a2a3',
  version: 1,
  size: 463,
  vsize: 463,
  weight: 1852,
  locktime: 0,
  vin: [
    {
      txid: '3510e4f7bf29660239dd00be5ae0a90bd543fe7432c585a2bbba364119dade02',
      vout: 2,
      scriptSig: [Object],
      sequence: 4294967295
    },
    {
      txid: 'a5db781167df1cc3269322cf8ba5593f867362677d3311d677f53543bce33cbf',
      vout: 3,
      scriptSig: [Object],
      sequence: 4294967295
    }
  ],
  vout: [
    { value: 0, n: 0, scriptPubKey: [Object] },
    { value: 0.000055, n: 1, scriptPubKey: [Object] },
    { value: 0.00000547, n: 2, scriptPubKey: [Object] },
    { value: 0.00013882, n: 3, scriptPubKey: [Object] }
  ]
}
```
