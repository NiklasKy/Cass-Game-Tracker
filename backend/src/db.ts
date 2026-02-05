import pg from 'pg';
import { getEnv } from './env.js';

const { Pool } = pg;

export function createPool() {
  const env = getEnv();
  return new Pool({
    connectionString: env.DATABASE_URL,
    max: 5
  });
}

