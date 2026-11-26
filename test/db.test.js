// Transacciones (withTransaction) y migraciones (migrate) con un cliente de pg simulado.
import { afterEach, describe, expect, it, vi } from 'vitest';

function fakeClient(failOn) {
  return {
    query: vi.fn(async (sql) => {
      if (failOn && failOn.test(String(sql))) throw new Error(`falló: ${sql}`);
      if (/SELECT filename FROM schema_migrations/.test(sql)) return { rows: [{ filename: '001_init.sql' }] };
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
}

afterEach(() => {
  vi.doUnmock('pg');
  vi.doUnmock('../src/db/pool.js');
  vi.resetModules();
});

describe('withTransaction', () => {
  async function load(client) {
    vi.resetModules();
    vi.doMock('pg', () => ({
      default: {
        Pool: class {
          connect() {
            return Promise.resolve(client);
          }
        },
      },
    }));
    return import('../src/db/pool.js');
  }

  it('hace COMMIT y devuelve el resultado', async () => {
    const client = fakeClient();
    const { withTransaction } = await load(client);
    const result = await withTransaction(async (c) => {
      await c.query('SELECT 1');
      return 42;
    });
    expect(result).toBe(42);
    expect(client.query.mock.calls.map(([s]) => s)).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    expect(client.release).toHaveBeenCalled();
  });

  it('hace ROLLBACK, relanza y libera la conexión si la función falla', async () => {
    const client = fakeClient();
    const { withTransaction } = await load(client);
    await expect(
      withTransaction(async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(client.query.mock.calls.map(([s]) => s)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalled();
  });
});

describe('migrate', () => {
  async function load(client) {
    vi.resetModules();
    vi.doMock('../src/db/pool.js', () => ({ pool: { connect: vi.fn().mockResolvedValue(client) } }));
    return import('../src/db/migrate.js');
  }

  it('aplica solo las migraciones pendientes, en orden y bajo el advisory lock', async () => {
    const client = fakeClient();
    const { migrate } = await load(client);
    await migrate();

    const calls = client.query.mock.calls;
    expect(calls[0][0]).toMatch(/pg_advisory_lock/);
    expect(calls.at(-1)[0]).toMatch(/pg_advisory_unlock/);
    const recorded = calls.filter(([s]) => /INSERT INTO schema_migrations/.test(s)).map(([, p]) => p[0]);
    expect(recorded).not.toContain('001_init.sql');
    expect(recorded.length).toBeGreaterThan(0);
    expect([...recorded].sort()).toEqual(recorded);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('si una migración falla hace ROLLBACK, informa el archivo y suelta el lock', async () => {
    const client = fakeClient(/^INSERT INTO schema_migrations/);
    const { migrate } = await load(client);
    await expect(migrate()).rejects.toThrow(/Migración .*\.sql falló/);
    const sqls = client.query.mock.calls.map(([s]) => s);
    expect(sqls).toContain('ROLLBACK');
    expect(sqls.at(-1)).toMatch(/pg_advisory_unlock/);
  });

  it('si no puede soltar el lock descarta la conexión', async () => {
    const client = fakeClient(/pg_advisory_unlock/);
    const { migrate } = await load(client);
    await migrate();
    expect(client.release.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});
