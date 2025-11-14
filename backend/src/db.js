// backend/src/db.js (ESM)
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://${process.env.POSTGRES_USER || 'postgres'}:${process.env.POSTGRES_PASSWORD || 'postgres'}@db:5432/${process.env.POSTGRES_DB || 'moviemix'}`
});

export default pool;
