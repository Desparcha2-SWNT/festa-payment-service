// Cuenta borrada contra PostgreSQL real: lápida, órdenes nuevas rechazadas y outbox anonimizado.
// Se salta sin TEST_DATABASE_URL (una base vacía; la prueba limpia las tablas al empezar).
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB = process.env.TEST_DATABASE_URL;
const ANON = '00000000-0000-0000-0000-000000000000';

describe.skipIf(!DB)('cuenta borrada (PostgreSQL real)', () => {
  let pool;
  let withTransaction;
  let handlers;
  let createOrder;
  const eventId = crypto.randomUUID();
  const buyer = crypto.randomUUID();
  const other = crypto.randomUUID();

  beforeAll(async () => {
    ({ pool, withTransaction } = await import('../src/db/pool.js'));
    const { migrate } = await import('../src/db/migrate.js');
    ({ handlers } = await import('../src/messaging/handlers.js'));
    ({ createOrder } = await import('../src/orders/repository.js'));
    await migrate();
    await pool.query('TRUNCATE outbox, orders, event_projection, deleted_accounts, closed_events RESTART IDENTITY CASCADE');
    await withTransaction((client) =>
      handlers['event.published'](
        {
          eventId, organizerId: crypto.randomUUID(), merchantId: crypto.randomUUID(), title: 'Concierto',
          startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
          capacity: 100, ticketed: true, priceCents: 5_000_000, maxTicketsPerOrder: 5, status: 'published', version: 1,
        },
        client,
      ),
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('al borrar la cuenta no se pierde ningún mensaje del outbox: se anonimiza el comprador', async () => {
    const created = await createOrder({ eventId, quantity: 1, buyerId: buyer });
    expect(created.outcome).toBe('created');
    const { rows: before } = await pool.query("SELECT count(*)::int AS n FROM outbox WHERE sent_at IS NULL AND payload->>'buyerId' = $1", [buyer]);
    expect(before[0].n).toBeGreaterThan(0);
    const { rows: total } = await pool.query('SELECT count(*)::int AS n FROM outbox WHERE sent_at IS NULL');

    await withTransaction((client) =>
      handlers['account.deleted']({ userId: buyer, deletedAt: new Date().toISOString() }, client, { eventId: crypto.randomUUID() }),
    );

    const { rows: still } = await pool.query("SELECT count(*)::int AS n FROM outbox WHERE payload->>'buyerId' = $1", [buyer]);
    expect(still[0].n).toBe(0); // ya no queda el comprador en ningún mensaje
    const { rows: after } = await pool.query('SELECT count(*)::int AS n FROM outbox WHERE sent_at IS NULL');
    expect(after[0].n).toBeGreaterThanOrEqual(total[0].n); // y no se borró ninguno (la orden vencida suma order.expired)
    const { rows: anon } = await pool.query("SELECT count(*)::int AS n FROM outbox WHERE payload->>'buyerId' = $1", [ANON]);
    expect(anon[0].n).toBeGreaterThan(0);
  });

  it('una cuenta borrada no puede abrir órdenes nuevas aunque su JWT siga vigente', async () => {
    const { rows } = await pool.query('SELECT 1 FROM deleted_accounts WHERE user_id = $1', [buyer]);
    expect(rows).toHaveLength(1);
    expect((await createOrder({ eventId, quantity: 1, buyerId: buyer })).outcome).toBe('account_deleted');
    expect((await createOrder({ eventId, quantity: 1, buyerId: other })).outcome).toBe('created'); // otra cuenta sí
  });

  it('procesar dos veces account.deleted no falla', async () => {
    await withTransaction((client) =>
      handlers['account.deleted']({ userId: buyer, deletedAt: new Date().toISOString() }, client, { eventId: crypto.randomUUID() }),
    );
  });
});
