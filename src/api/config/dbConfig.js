const { Pool } = require('pg');

const pool = new Pool({
  user: 'docker',
  host: 'localhost',
  database: 'zero_code_db',
  password: 'docker',
  port: 5433,
});

module.exports = pool;
