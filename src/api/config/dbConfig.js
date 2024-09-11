import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();
const { Pool } = pg;

const pool = new Pool({
  user:process.env.USER_DB,
  host: process.env.HOST_DB,
  database: process.env.DATABASE_DB,
  password: process.env.PASSWORD_DB,
  port: process.env.PORT_DB,
  ssl: {
    rejectUnauthorized: false  // This allows connecting without strict SSL verification
}
});

export default pool;
