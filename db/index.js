const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool(config.postgres);

module.exports = {
    query: (sql, params) => pool.query(sql, params)
}
