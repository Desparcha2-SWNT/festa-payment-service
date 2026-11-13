// Respuestas HTTP de la API de pagos y del webhook, con el repositorio simulado.
import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { jwtPrivateKeyPem } from './fixtures/jwtKeys.js';

const repo = vi.hoisted(() => ({
  createOrder: vi.fn(),
  findOrderById: vi.fn(),
  findOrdersByBuyer: vi.fn(),
  quote: vi.fn(),
  applyTransaction: vi.fn(),
  adminRequestRefund: vi.fn(),
  listRefundRequests: vi.fn(),
  markRefunded: vi.fn(),
  pendingPayouts: vi.fn(),
  recordPayout: vi.fn(),
  merchantSummary: vi.fn(),
  toApi: (row) => ({ orderId: row.id, status: row.status, totalCents: row.total_cents }),
}));
const db = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../src/orders/repository.js', () => repo);
vi.mock('../src/db/pool.js', () => ({ pool: db, withTransaction: vi.fn() }));

process.env.WOMPI_EVENTS_SECRET = 'evt-secret';
process.env.WOMPI_INTEGRITY_SECRET = 'int-secret';
const { createApp } = await import('../src/app.js');

const USER = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const EVENT_ID = '6f1c2b8e-3a1d-4c3e-9b0a-1f2e3d4c5b6a';
const sign = (role) =>
  jwt.sign({ role }, jwtPrivateKeyPem, { algorithm: 'RS256', issuer: process.env.JWT_ISSUER, subject: USER, expiresIn: '15m' });
const as = (role) => (req) => req.set('Authorization', `Bearer ${sign(role)}`);
const user = as('user');
const admin = as('admin');

beforeEach(() => vi.clearAllMocks());

describe('POST /payments/orders', () => {
  it('pide token', async () => {
    expect((await request(createApp()).post('/payments/orders').send({})).status).toBe(401);
  });

  it('valida el cuerpo', async () => {
    const res = await user(request(createApp()).post('/payments/orders')).send({ eventId: 'x', quantity: 0 });
    expect(res.status).toBe(400);
  });

  it('crea la orden y devuelve el checkout de Wompi', async () => {
    repo.createOrder.mockResolvedValue({
      outcome: 'created',
      order: { id: 'o1', status: 'PENDING', reference: 'FESTA-o1', total_cents: 5400000 },
    });
    const res = await user(request(createApp()).post('/payments/orders')).set('Idempotency-Key', 'abc12345').send({ eventId: EVENT_ID, quantity: 2 });

    expect(res.status).toBe(201);
    expect(res.body.checkout.reference).toBe('FESTA-o1');
    expect(res.body.checkout.amountInCents).toBe(5400000);
    expect(repo.createOrder).toHaveBeenCalledWith(expect.objectContaining({ buyerId: USER, idempotencyKey: 'abc12345', quantity: 2 }));
  });

  it.each([
    ['sold_out', 409],
    ['not_found', 404],
    ['not_ticketed', 409],
  ])('%s da %i', async (outcome, status) => {
    repo.createOrder.mockResolvedValue({ outcome });
    const res = await user(request(createApp()).post('/payments/orders')).send({ eventId: EVENT_ID, quantity: 1 });
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(outcome);
  });
});

describe('GET /payments/orders/:id', () => {
  it('no deja ver órdenes ajenas', async () => {
    repo.findOrderById.mockResolvedValue({ id: 'o1', buyer_id: 'otro', status: 'APPROVED' });
    const res = await user(request(createApp()).get(`/payments/orders/${EVENT_ID}`));
    expect(res.status).toBe(404);
  });
});

describe('admin', () => {
  it('un usuario normal recibe 403', async () => {
    const res = await user(request(createApp()).get('/payments/admin/refunds'));
    expect(res.status).toBe(403);
  });

  it('el admin lista reembolsos pendientes', async () => {
    repo.listRefundRequests.mockResolvedValue([{ id: 'o1', status: 'REFUND_REQUESTED', total_cents: 1 }]);
    const res = await admin(request(createApp()).get('/payments/admin/refunds'));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });
});

describe('POST /webhooks/wompi', () => {
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  function body(status = 'APPROVED') {
    const transaction = { id: 'tx-1', status, amount_in_cents: 5400000, reference: 'FESTA-o1', payment_method_type: 'NEQUI' };
    const timestamp = 1700000000;
    return {
      event: 'transaction.updated',
      data: { transaction },
      signature: {
        properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
        checksum: sha(`tx-1${status}5400000${timestamp}evt-secret`),
      },
      timestamp,
    };
  }

  it('rechaza una firma inválida', async () => {
    const b = body();
    b.signature.checksum = 'f'.repeat(64);
    const res = await request(createApp()).post('/webhooks/wompi').send(b);
    expect(res.status).toBe(401);
    expect(repo.applyTransaction).not.toHaveBeenCalled();
  });

  it('aplica la transacción firmada', async () => {
    db.query.mockResolvedValue({ rowCount: 1 });
    repo.applyTransaction.mockResolvedValue({ outcome: 'approved' });
    const res = await request(createApp()).post('/webhooks/wompi').send(body());

    expect(res.status).toBe(200);
    expect(repo.applyTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ reference: 'FESTA-o1', status: 'APPROVED', amountInCents: 5400000 }),
      null,
    );
  });

  it('ignora un webhook repetido', async () => {
    db.query.mockResolvedValue({ rowCount: 0 });
    const res = await request(createApp()).post('/webhooks/wompi').send(body());
    expect(res.body.duplicate).toBe(true);
    expect(repo.applyTransaction).not.toHaveBeenCalled();
  });
});

describe('sistema', () => {
  it('/health y /metrics responden', async () => {
    expect((await request(createApp()).get('/health')).status).toBe(200);
    const metrics = await request(createApp()).get('/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.text).toContain('process_cpu');
  });
});
