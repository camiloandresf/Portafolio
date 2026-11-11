import { PGlite } from '@electric-sql/pglite';
import { Pool, PoolClient } from 'pg';
export interface SQL { query(sql: string, params?: any[]): Promise<{ rows: any[] }> }
export interface Database extends SQL { transaction<T>(fn: (tx: SQL) => Promise<T>): Promise<T>; close(): Promise<void> }
export async function openDatabase(memory = false): Promise<Database> {
  let db: Database;
  if (!memory && process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = { query: (s, p) => pool.query(s, p), close: () => pool.end(), async transaction(fn) {
      const client: PoolClient = await pool.connect();
      try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
      catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    } };
  } else {
    const local = new PGlite(memory ? undefined : (process.env.DATA_DIR || './data'));
    await local.waitReady;
    db = { query: (s, p) => local.query(s, p), transaction: fn => local.transaction(tx => fn(tx)), close: () => local.close() };
  }
  await db.query(`CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
    reference TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0), currency TEXT NOT NULL DEFAULT 'CLP',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
  await db.query(`CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id), fingerprint TEXT NOT NULL,
    outcome TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
  await db.query(`CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id), payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_at TIMESTAMPTZ NOT NULL, processed_at TIMESTAMPTZ, last_error TEXT);`);
  return db;
}
