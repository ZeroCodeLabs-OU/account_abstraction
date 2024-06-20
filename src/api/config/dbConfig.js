import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  user: 'docker',
  host: 'localhost',
  database: 'zero_code_db',
  password: 'docker',
  port: 5433,
});

export default pool;
