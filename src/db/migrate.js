import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';
import { logger } from '../logger.js';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

// Arbitrario pero fijo: solo tiene que no chocar con otro advisory lock de este cluster de
// Postgres. Cada servicio corre contra su propia base (booking_db), así que ni hace falta que
// sea único entre servicios, solo estable entre arranques de este mismo.
const MIGRATION_LOCK_KEY = 0x4650_4159;

export async function migrate() {
  // Advisory lock de sesión (una sola conexión para pedirlo y soltarlo): si dos réplicas de
  // este servicio arrancan a la vez, la segunda espera aquí a que la primera termine, en vez
  // de que ambas vean la misma migración como "no aplicada" y la corran dos veces.
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = new Set((await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename));
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info({ file }, 'migración aplicada');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migración ${file} falló: ${err.message}`, { cause: err });
      }
    }
  } finally {
    let unlockError;
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } catch (err) {
      unlockError = err;
      // Si esto falla, el lock pudo quedar atado a la conexión: se la pasamos a release()
      // para que pg la descarte del pool en vez de devolver una conexión que todavía lo tiene.
      logger.warn({ err }, 'no se pudo soltar el advisory lock de migraciones, se descarta la conexión');
    }
    client.release(unlockError);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      logger.error(err);
      process.exitCode = 1;
      return pool.end();
    });
}
