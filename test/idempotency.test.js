// Dos solicitudes simultáneas con el mismo Idempotency-Key deben terminar en la misma orden, no en un 500.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ client: { query: vi.fn() }, pool: { query: vi.fn() } }));
vi.mock('../src/db/pool.js', () => ({ pool: db.pool, withTransaction: async (fn) => fn(db.client) }));
vi.mock('../src/messaging/outboxRepository.js', () => ({ enqueue: vi.fn() }));

const { createOrder } = await import('../src/orders/repository.js');

const EVENT_ID = '6f1c2b8e-3a1d-4c3e-9b0a-1f2e3d4c5b6a';
const BUYER = '0b9c7d6e-5f4a-4b3c-8d2e-1a0b9c8d7e6f';
const KEY = 'clave-12345';
const event = {
  event_id: EVENT_ID, title: 'Jazz', capacity: 80, sold: 0, held: 0, ticketed: true, price_cents: 2_500_000,
  max_tickets_per_order: 4, status: 'published', ends_at: new Date('2099-01-01T04:00:00Z'),
};
const existing = { id: 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b', buyer_id: BUYER, idempotency_key: KEY, title: 'Jazz' };
const isKeyLookup = (sql) => /o\.idempotency_key = \$2/.test(sql);

describe('createOrder: Idempotency-Key concurrente', () => {
  beforeEach(() => {
    db.client.query.mockReset();
    db.pool.query.mockReset();
  });

  it('si la otra solicitud creó la orden mientras se esperaba el bloqueo del evento, devuelve esa orden', async () => {
    let lookups = 0;
    db.client.query.mockImplementation(async (sql) => {
      if (isKeyLookup(sql)) return { rows: lookups++ === 0 ? [] : [existing] };
      if (/FOR UPDATE/.test(sql)) return { rows: [event] };
      throw new Error(`no debería llegar a: ${sql}`);
    });

    const result = await createOrder({ eventId: EVENT_ID, quantity: 1, buyerId: BUYER, idempotencyKey: KEY });
    expect(result).toEqual({ outcome: 'existing', order: existing });
    expect(db.client.query.mock.calls.some(([sql]) => /INSERT INTO orders/.test(sql))).toBe(false);
  });

  it('si el INSERT choca con el índice de idempotencia, devuelve la orden ya guardada', async () => {
    db.client.query.mockImplementation(async (sql) => {
      if (isKeyLookup(sql)) return { rows: [] };
      if (/FOR UPDATE/.test(sql)) return { rows: [event] };
      if (/INSERT INTO orders/.test(sql)) {
        throw Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'orders_idempotency_idx' });
      }
      return { rows: [] };
    });
    db.pool.query.mockResolvedValue({ rows: [existing] });

    const result = await createOrder({ eventId: EVENT_ID, quantity: 1, buyerId: BUYER, idempotencyKey: KEY });
    expect(result).toEqual({ outcome: 'existing', order: existing });
  });

  it('otro error de unicidad se sigue propagando', async () => {
    db.client.query.mockImplementation(async (sql) => {
      if (isKeyLookup(sql)) return { rows: [] };
      if (/FOR UPDATE/.test(sql)) return { rows: [event] };
      if (/INSERT INTO orders/.test(sql)) {
        throw Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'orders_reference_key' });
      }
      return { rows: [] };
    });

    await expect(createOrder({ eventId: EVENT_ID, quantity: 1, buyerId: BUYER, idempotencyKey: KEY })).rejects.toThrow(
      'duplicate key',
    );
    expect(db.pool.query).not.toHaveBeenCalled();
  });
});
