module.exports = {
    postgres: {
	host: process.env.PGHOST || 'localhost',
	database: process.env.PGDATABASE || 'bitcoin-supply_dev',
	user: process.env.PGUSER || 'bitcoin-supply',
	password: process.env.PGPASSWORD || 'supersecretpassword',
	ssl: false,
	debug: false
    },

    paginationSize: 250,

    bitcoinRPC: {
	host: process.env.RPCHOST || '127.0.0.1',
	port: process.env.RPCPORT || 8332,
	network: process.env.RPCNETWORK || 'mainnet',
	username: process.env.RPCUSERNAME || 'rpcuser',
	password: process.env.RPCPASSWORD || 'supersecretpassword'
    }

}
