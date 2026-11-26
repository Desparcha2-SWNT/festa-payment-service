// La moneda de la transacción debe coincidir con la de la orden antes de aprobarla.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ client: { query: vi.fn() } }));
vi.mock('../src/db/pool.js', () => ({
  pool: { query: vi.fn() },
  withTransaction: async (fn) => fn(db.client),
}));
vi.mock('../src/messaging/outboxRepository.js', () => ({ enqueue: vi.fn() }));

const { applyTransaction } = await import('../src/orders/repository.js');

const order = { id: 'o1', event_id: 'e1', reference: 'FESTA-o1', status: 'PENDING', total_cents: 5000000, quantity: 1 };

describe('applyTransaction: moneda', () => {
  beforeEach(() => {
    db.client.query.mockReset();
    db.client.query.mockResolvedValue({ rows: [order] });
  });

  it('rechaza una transacción en otra moneda sin aprobar la orden', async () => {
    const res = await applyTransaction({ reference: 'FESTA-o1', status: 'APPROVED', amountInCents: 5000000, currency: 'USD' });
    expect(res.outcome).toBe('currency_mismatch');
    const sqls = db.client.query.mock.calls.map((c) => c[0]);
    expect(sqls.some((s) => /UPDATE orders/.test(s))).toBe(false);
    expect(sqls.some((s) => /UPDATE event_projection/.test(s))).toBe(false);
  });

  it('rechaza una transacción sin moneda', async () => {
    const res = await applyTransaction({ reference: 'FESTA-o1', status: 'APPROVED', amountInCents: 5000000 });
    expect(res.outcome).toBe('currency_mismatch');
  });

  it('acepta COP y la orden sigue su flujo', async () => {
    db.client.query.mockResolvedValueOnce({ rows: [order] }).mockResolvedValue({
      rows: [{ id: 'e1', capacity: null, sold: 0, held: 1, status: 'published', price_cents: 0 }],
    });
    const res = await applyTransaction({ reference: 'FESTA-o1', status: 'DECLINED', amountInCents: 5000000, currency: 'COP' });
    expect(res.outcome).not.toBe('currency_mismatch');
  });
});
