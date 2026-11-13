// Lo que publica payment-service debe cumplir los esquemas reales de festa-infra/contracts.
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const h = vi.hoisted(() => ({ enqueue: vi.fn(), client: null }));
vi.mock('../src/db/pool.js', () => ({ pool: {}, withTransaction: (fn) => fn(h.client) }));
vi.mock('../src/messaging/outboxRepository.js', () => ({ enqueue: h.enqueue }));

const repo = await import('../src/orders/repository.js');

const contractsDir = process.env.FESTA_CONTRACTS_DIR ?? path.resolve('../festa-infra/contracts');
const schemaFile = (name) => path.join(contractsDir, `events/payment/${name}.schema.json`);
function validator(name) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(JSON.parse(fs.readFileSync(schemaFile(name), 'utf8')));
}
function expectValid(name, payload) {
  const validate = validator(name);
  validate(payload);
  expect(validate.errors, JSON.stringify(validate.errors, null, 2)).toBeNull();
}

const EVENT_ID = '6f1c2b8e-3a1d-4c3e-9b0a-1f2e3d4c5b6a';
const ORGANIZER = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const MERCHANT = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const BUYER = '0b9c7d6e-5f4a-4b3c-8d2e-1a0b9c8d7e6f';
const ADMIN = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const ORDER_ID = 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b';

const event = {
  event_id: EVENT_ID, organizer_id: ORGANIZER, merchant_id: MERCHANT, title: 'Jazz', capacity: 80, sold: 0, held: 0,
  ticketed: true, price_cents: 2_500_000, max_tickets_per_order: 4, status: 'published',
  starts_at: new Date('2099-01-01T01:00:00Z'), ends_at: new Date('2099-01-01T04:00:00Z'),
};
const order = {
  id: ORDER_ID, reference: 'FESTA-x', event_id: EVENT_ID, organizer_id: ORGANIZER, merchant_id: MERCHANT, buyer_id: BUYER,
  quantity: 2, unit_price_cents: 2_500_000, subtotal_cents: 5_000_000, commission_cents: 400_000, total_cents: 5_400_000,
  currency: 'COP', status: 'PENDING', approved_at: null, created_at: new Date(), expires_at: new Date(),
};

/** Cliente de Postgres falso que responde según el SQL. */
function fakeClient(overrides = {}) {
  return {
    query: vi.fn(async (sql) => {
      if (/FROM event_projection WHERE event_id = \$1 FOR UPDATE/.test(sql)) return { rows: [overrides.event ?? event] };
      if (/FROM orders WHERE reference = \$1 FOR UPDATE/.test(sql)) return { rows: [overrides.order ?? order] };
      if (/FROM orders WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: [overrides.order ?? order] };
      if (/^\s*INSERT INTO orders/.test(sql)) return { rows: [{ ...order, created_at: new Date() }] };
      if (/UPDATE orders SET status = 'APPROVED'/.test(sql)) {
        return { rows: [{ ...order, status: 'APPROVED', approved_at: new Date(), payment_method: 'NEQUI', provider_transaction_id: 'tx-1' }] };
      }
      if (/UPDATE orders SET status = 'REFUND_REQUESTED'/.test(sql)) return { rows: [{ ...order, refund_requested_at: new Date() }] };
      if (/UPDATE orders SET status = 'REFUNDED'/.test(sql)) return { rows: [{ ...order, refunded_at: new Date() }] };
      if (/UPDATE orders SET status = 'EXPIRED'/.test(sql)) return { rows: [{ updated_at: new Date() }] };
      if (/UPDATE orders SET status = \$2/.test(sql)) return { rows: [{ ...order, status: 'DECLINED' }] };
      if (/FROM orders o JOIN event_projection e USING \(event_id\)\s+WHERE o.status = 'APPROVED' AND o.payout_id IS NULL AND o.merchant_id/.test(sql)) {
        return { rows: [{ ...order, status: 'APPROVED', approved_at: new Date('2026-11-01T00:00:00Z') }] };
      }
      if (/INSERT INTO payouts/.test(sql)) return { rows: [{ id: 'b8c9d0e1-f2a3-4b4c-9d5e-6f7a8b9c0d1e', organizer_id: ORGANIZER }] };
      return { rows: [], rowCount: 1 };
    }),
  };
}

const lastPayload = (routingKey) => h.enqueue.mock.calls.filter((c) => c[1].routingKey === routingKey).at(-1)[1].payload;

beforeEach(() => {
  h.enqueue.mockClear();
  h.client = fakeClient();
});

describe.skipIf(!fs.existsSync(schemaFile('order.created')))('contratos de payment-service', () => {
  it('order.created', async () => {
    const result = await repo.createOrder({ eventId: EVENT_ID, quantity: 2, buyerId: BUYER });
    expect(result.outcome).toBe('created');
    expectValid('order.created', lastPayload('order.created'));
  });

  it('createOrder respeta el cupo y el máximo por orden', async () => {
    h.client = fakeClient({ event: { ...event, capacity: 3, sold: 2, held: 0 } });
    expect((await repo.createOrder({ eventId: EVENT_ID, quantity: 2, buyerId: BUYER })).outcome).toBe('sold_out');
    h.client = fakeClient();
    expect((await repo.createOrder({ eventId: EVENT_ID, quantity: 5, buyerId: BUYER })).outcome).toBe('too_many');
  });

  it('order.approved', async () => {
    const result = await repo.applyTransaction({ reference: 'FESTA-x', status: 'APPROVED', amountInCents: 5_400_000, transactionId: 'tx-1', paymentMethodType: 'NEQUI' });
    expect(result.outcome).toBe('approved');
    expectValid('order.approved', lastPayload('order.approved'));
  });

  it('rechaza un monto distinto al de la orden', async () => {
    const result = await repo.applyTransaction({ reference: 'FESTA-x', status: 'APPROVED', amountInCents: 1 });
    expect(result.outcome).toBe('amount_mismatch');
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('order.failed', async () => {
    const result = await repo.applyTransaction({ reference: 'FESTA-x', status: 'DECLINED', amountInCents: 5_400_000, transactionId: 'tx-2', statusMessage: 'Fondos insuficientes' });
    expect(result.outcome).toBe('failed');
    expectValid('order.failed', lastPayload('order.failed'));
  });

  it('order.expired', async () => {
    await repo.expireOrder(h.client, order);
    expectValid('order.expired', lastPayload('order.expired'));
  });

  it('order.refund_requested', async () => {
    await repo.requestRefund(h.client, { ...order, status: 'APPROVED' }, 'event_cancelled');
    expectValid('order.refund_requested', lastPayload('order.refund_requested'));
  });

  it('order.refunded', async () => {
    h.client = fakeClient({ order: { ...order, status: 'REFUND_REQUESTED', approved_at: new Date(), payout_id: null } });
    const result = await repo.markRefunded(ORDER_ID, ADMIN, 'Reverso Wompi 123');
    expect(result.outcome).toBe('refunded');
    expectValid('order.refunded', lastPayload('order.refunded'));
  });

  it('payout.recorded', async () => {
    const result = await repo.recordPayout(MERCHANT, ADMIN, { reference: 'Transferencia 1' });
    expect(result.outcome).toBe('recorded');
    expectValid('payout.recorded', lastPayload('payout.recorded'));
  });
});
