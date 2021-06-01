exports.format = (num, depth) => {
    depth = depth || 0;
    const tuple = Number.parseFloat(num).toFixed(depth).split('.');
    tuple[0] = tuple[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return tuple.join('.');
};

exports.allowed_supply = (height) => {
    const halflife = 210000n;   // 210,000 blocks
    let coinbase = 5000000000n; // 50 BTC

    const block = BigInt(height);
    const halvings = Number(((block / halflife) + 1n).toString());

    for (let x=1; x<halvings; x++)
        coinbase = coinbase / 2n;

    return coinbase.toString();
};

exports.isHex = (str) => str.match(/[0-9a-f]/gi).length == str.length;

exports.limit = (str, len) => str.length > len ? str.substr(0, len) + '...' : str;
