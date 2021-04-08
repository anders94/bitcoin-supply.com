const bigInt = require("big-integer");

exports.format = (num, depth) => {
    depth = depth || 0;
    const tuple = Number.parseFloat(num).toFixed(depth).split('.');
    tuple[0] = tuple[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return tuple.join('.');
};

exports.allowed_supply = (height) => {
    const halflife = bigInt(210000);   // 210,000 blocks
    let coinbase = bigInt(5000000000); // 50 BTC

    const block = bigInt(height);
    const halvings = Number(block.divide(halflife).add(1).toString());

    for (let x=1; x<halvings; x++)
        coinbase=coinbase.divide(2);

    return coinbase.toString();
};

exports.isHex = (str) => str.match(/[0-9a-f]/gi).length == str.length;

exports.limit = (str, len) => str.length > len ? str.substr(0, len) + '...' : str;
