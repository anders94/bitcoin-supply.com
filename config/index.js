module.exports = {
    postgres: {
	host: process.env.PGHOST || 'localhost',
	database: process.env.PGDATABASE || 'bitcoin-supply_dev',
	user: process.env.PGUSER || 'bitcoin-supply',
	password: process.env.PGPASSWORD || '',
	ssl: false,
	debug: false
    },

    email: {
        host: process.env.EMAILHOST || 'localhost',
        port: process.env.EMAILPORT || 1025,
        auth: {
            user: process.env.EMAILUSER || 'project.1',
            pass: process.env.EMAILPASSWORD || 'secret.1'
        }
    }
}
