import pkg from 'pg';
const {Pool} = pkg;

const pool = new Pool({
  user: 'docker',
  host: 'localhost',
  database: 'zero_code_db',
  password: 'docker',
  port: 5433,
});

export default pool;
