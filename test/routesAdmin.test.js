// Rutas de cotización, órdenes propias, simulación, resumen del comercio, reembolsos y liquidaciones,
// con el repositorio simulado (sin base).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('../src/orders/repository.js', () => repo);
vi.mock('../src/db/pool.js', () => ({ pool: { query: vi.fn() }, withTransaction: vi.fn() }));

process.env.WOMPI_EVENTS_SECRET = 'evt-secret';
process.env.WOMPI_INTEGRITY_SECRET = 'int-secret';
const { createApp } = await import('../src/app.js');

const USER = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const ID = '6f1c2b8e-3a1d-4c3e-9b0a-1f2e3d4c5b6a';
const sign = (role) =>
  jwt.sign({ role }, jwtPrivateKeyPem, { algorithm: 'RS256', issuer: process.env.JWT_ISSUER, subject: USER, expiresIn: '15m' });
const as = (role) => (req) => req.set('Authorization', `Bearer ${sign(role)}`).set('X-Correlation-ID', 'corr-1');
const user = as('user');
const admin = as('admin');
const app = createApp();
const boom = () => Promise.reject(new Error('base caída'));

beforeEach(() => vi.resetAllMocks());

describe('GET /payments/events/:id/quote', () => {
  it('rechaza un id que no es uuid', async () => {
    expect((await user(request(app).get('/payments/events/xyz/quote'))).status).toBe(400);
  });

  it('rechaza una cantidad fuera de rango', async () => {
    expect((await user(request(app).get(`/payments/events/${ID}/quote?quantity=11`))).status).toBe(400);
  });

  it('devuelve la cotización con cantidad 1 por defecto', async () => {
    repo.quote.mockResolvedValue({ outcome: 'ok', quote: { totalCents: 100 } });
    const res = await user(request(app).get(`/payments/events/${ID}/quote`));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ totalCents: 100 });
    expect(repo.quote).toHaveBeenCalledWith(ID, 1);
  });

  it('traduce too_many con el máximo y sold_out con los disponibles', async () => {
    repo.quote.mockResolvedValueOnce({ outcome: 'too_many', max: 4 });
    let res = await user(request(app).get(`/payments/events/${ID}/quote?quantity=5`));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'too_many', max: 4 });

    repo.quote.mockResolvedValueOnce({ outcome: 'sold_out', available: 0 });
    res = await user(request(app).get(`/payments/events/${ID}/quote?quantity=2`));
    expect(res.body).toMatchObject({ code: 'sold_out', available: 0 });
  });

  it('un error del repositorio da 500', async () => {
    repo.quote.mockImplementation(boom);
    expect((await user(request(app).get(`/payments/events/${ID}/quote`))).status).toBe(500);
  });
});

describe('POST /payments/orders (casos extra)', () => {
  it('rechaza un Idempotency-Key mal formado', async () => {
    const res = await user(request(app).post('/payments/orders')).set('Idempotency-Key', 'a b').send({ eventId: ID, quantity: 1 });
    expect(res.status).toBe(400);
    expect(repo.createOrder).not.toHaveBeenCalled();
  });

  it('una orden repetida ya aprobada responde 200 sin checkout', async () => {
    repo.createOrder.mockResolvedValue({ outcome: 'existing', order: { id: 'o1', status: 'APPROVED', total_cents: 1 } });
    const res = await user(request(app).post('/payments/orders')).send({ eventId: ID, quantity: 1 });
    expect(res.status).toBe(200);
    expect(res.body.checkout).toBeUndefined();
    expect(repo.createOrder).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: null, correlationId: 'corr-1' }));
  });

  it('un error del repositorio da 500', async () => {
    repo.createOrder.mockImplementation(boom);
    expect((await user(request(app).post('/payments/orders')).send({ eventId: ID, quantity: 1 })).status).toBe(500);
  });
});

describe('órdenes del comprador', () => {
  it('lista las propias', async () => {
    repo.findOrdersByBuyer.mockResolvedValue([{ id: 'o1', status: 'APPROVED', total_cents: 5 }]);
    const res = await user(request(app).get('/payments/orders/mine'));
    expect(res.body.items).toEqual([{ orderId: 'o1', status: 'APPROVED', totalCents: 5 }]);
    expect(repo.findOrdersByBuyer).toHaveBeenCalledWith(USER);
  });

  it('la lista propia da 500 si falla la base', async () => {
    repo.findOrdersByBuyer.mockImplementation(boom);
    expect((await user(request(app).get('/payments/orders/mine'))).status).toBe(500);
  });

  it('la orden propia pendiente trae el checkout', async () => {
    repo.findOrderById.mockResolvedValue({ id: 'o1', buyer_id: USER, status: 'PENDING', reference: 'FESTA-o1', total_cents: 300 });
    const res = await user(request(app).get(`/payments/orders/${ID}`));
    expect(res.status).toBe(200);
    expect(res.body.checkout).toMatchObject({ reference: 'FESTA-o1', amountInCents: 300 });
  });

  it('el admin ve una orden ajena', async () => {
    repo.findOrderById.mockResolvedValue({ id: 'o1', buyer_id: 'otro', status: 'APPROVED', total_cents: 1 });
    expect((await admin(request(app).get(`/payments/orders/${ID}`))).status).toBe(200);
  });

  it('una orden inexistente da 404 y un error da 500', async () => {
    repo.findOrderById.mockResolvedValueOnce(null);
    expect((await user(request(app).get(`/payments/orders/${ID}`))).status).toBe(404);
    repo.findOrderById.mockImplementationOnce(boom);
    expect((await user(request(app).get(`/payments/orders/${ID}`))).status).toBe(500);
  });
});

describe('POST /payments/orders/:id/simulate', () => {
  afterEach(() => delete process.env.PAYMENTS_ALLOW_SIMULATION);

  it('no existe si la simulación no está habilitada', async () => {
    const res = await user(request(app).post(`/payments/orders/${ID}/simulate`)).send({ status: 'APPROVED' });
    expect(res.status).toBe(404);
    expect(repo.applyTransaction).not.toHaveBeenCalled();
  });

  it('valida el estado', async () => {
    process.env.PAYMENTS_ALLOW_SIMULATION = 'true';
    expect((await user(request(app).post(`/payments/orders/${ID}/simulate`)).send({ status: 'PAID' })).status).toBe(400);
  });

  it('solo el comprador puede simular su orden', async () => {
    process.env.PAYMENTS_ALLOW_SIMULATION = 'true';
    repo.findOrderById.mockResolvedValue({ id: 'o1', buyer_id: 'otro' });
    expect((await user(request(app).post(`/payments/orders/${ID}/simulate`)).send({ status: 'APPROVED' })).status).toBe(404);
  });

  it('aplica una transacción simulada con el monto de la orden', async () => {
    process.env.PAYMENTS_ALLOW_SIMULATION = 'true';
    repo.findOrderById.mockResolvedValue({ id: 'o1', buyer_id: USER, reference: 'FESTA-o1', total_cents: 900 });
    repo.applyTransaction.mockResolvedValue({ outcome: 'approved', order: { id: 'o1', status: 'APPROVED', total_cents: 900 } });
    const res = await user(request(app).post(`/payments/orders/${ID}/simulate`)).send({ status: 'APPROVED' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'approved', orderId: 'o1', status: 'APPROVED' });
    expect(repo.applyTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ reference: 'FESTA-o1', amountInCents: 900, currency: 'COP', status: 'APPROVED', statusMessage: null }),
      'corr-1',
    );
  });

  it('un rechazo simulado lleva mensaje y sin orden devuelve solo el resultado', async () => {
    process.env.PAYMENTS_ALLOW_SIMULATION = 'true';
    repo.findOrderById.mockResolvedValue({ id: 'o1', buyer_id: USER, reference: 'R', total_cents: 1 });
    repo.applyTransaction.mockResolvedValue({ outcome: 'ignored' });
    const res = await user(request(app).post(`/payments/orders/${ID}/simulate`)).send({ status: 'DECLINED' });
    expect(res.body).toEqual({ outcome: 'ignored' });
    expect(repo.applyTransaction.mock.calls[0][0].statusMessage).toBe('simulado');
  });

  it('un error da 500', async () => {
    process.env.PAYMENTS_ALLOW_SIMULATION = 'true';
    repo.findOrderById.mockImplementation(boom);
    expect((await user(request(app).post(`/payments/orders/${ID}/simulate`)).send({ status: 'APPROVED' })).status).toBe(500);
  });
});

describe('GET /payments/merchants/me/summary', () => {
  it('devuelve el resumen del usuario autenticado', async () => {
    repo.merchantSummary.mockResolvedValue({ ticketsSold: 3 });
    const res = await user(request(app).get('/payments/merchants/me/summary'));
    expect(res.body).toEqual({ ticketsSold: 3 });
    expect(repo.merchantSummary).toHaveBeenCalledWith(USER);
  });

  it('un error da 500', async () => {
    repo.merchantSummary.mockImplementation(boom);
    expect((await user(request(app).get('/payments/merchants/me/summary'))).status).toBe(500);
  });
});

describe('admin: reembolsos', () => {
  it('la lista de reembolsos da 500 si falla la base', async () => {
    repo.listRefundRequests.mockImplementation(boom);
    expect((await admin(request(app).get('/payments/admin/refunds'))).status).toBe(500);
  });

  it('pide el reembolso de una orden', async () => {
    repo.adminRequestRefund.mockResolvedValue({ outcome: 'refund_requested', order: { id: 'o1', status: 'REFUND_REQUESTED', total_cents: 1 } });
    const res = await admin(request(app).post(`/payments/admin/orders/${ID}/refund-request`));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REFUND_REQUESTED');
    expect(repo.adminRequestRefund).toHaveBeenCalledWith(ID, 'corr-1');
  });

  it.each([
    ['not_found', 404],
    ['conflict', 409],
    ['already_paid_out', 409],
  ])('pedir reembolso con %s da %i', async (outcome, status) => {
    repo.adminRequestRefund.mockResolvedValue({ outcome });
    const res = await admin(request(app).post(`/payments/admin/orders/${ID}/refund-request`));
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(outcome);
  });

  it('pedir reembolso da 500 si falla', async () => {
    repo.adminRequestRefund.mockImplementation(boom);
    expect((await admin(request(app).post(`/payments/admin/orders/${ID}/refund-request`))).status).toBe(500);
  });

  it('marca reembolsada una orden con la referencia del admin', async () => {
    repo.markRefunded.mockResolvedValue({ outcome: 'refunded', order: { id: 'o1', status: 'REFUNDED', total_cents: 1 } });
    const res = await admin(request(app).post(`/payments/admin/orders/${ID}/refund`)).send({ reference: ' TRX-1 ' });
    expect(res.status).toBe(200);
    expect(repo.markRefunded).toHaveBeenCalledWith(ID, USER, 'TRX-1', 'corr-1');
  });

  it('marcar reembolso valida el cuerpo, traduce conflictos y errores', async () => {
    expect((await admin(request(app).post(`/payments/admin/orders/${ID}/refund`)).send({ otro: 1 })).status).toBe(400);
    repo.markRefunded.mockResolvedValueOnce({ outcome: 'conflict' });
    expect((await admin(request(app).post(`/payments/admin/orders/${ID}/refund`)).send({})).status).toBe(409);
    repo.markRefunded.mockImplementationOnce(boom);
    expect((await admin(request(app).post(`/payments/admin/orders/${ID}/refund`)).send({})).status).toBe(500);
  });
});

describe('admin: liquidaciones', () => {
  it('lista las liquidaciones pendientes', async () => {
    repo.pendingPayouts.mockResolvedValue([{ merchantId: 'm', amountCents: 10 }]);
    const res = await admin(request(app).get('/payments/admin/payouts/pending'));
    expect(res.body.items).toEqual([{ merchantId: 'm', amountCents: 10 }]);
    repo.pendingPayouts.mockImplementation(boom);
    expect((await admin(request(app).get('/payments/admin/payouts/pending'))).status).toBe(500);
  });

  it('un usuario normal no puede registrar liquidaciones', async () => {
    expect((await user(request(app).post('/payments/admin/payouts')).send({ merchantId: ID })).status).toBe(403);
  });

  it('registra una liquidación', async () => {
    repo.recordPayout.mockResolvedValue({ outcome: 'recorded', payout: { payoutId: 'p1' } });
    const body = { merchantId: ID, reference: 'BANCO-1', paidAt: '2026-11-20T10:00:00Z' };
    const res = await admin(request(app).post('/payments/admin/payouts')).send(body);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ payoutId: 'p1' });
    expect(repo.recordPayout).toHaveBeenCalledWith(ID, USER, body, 'corr-1');
  });

  it('valida el cuerpo, traduce nothing_to_pay y errores', async () => {
    expect((await admin(request(app).post('/payments/admin/payouts')).send({ merchantId: 'x' })).status).toBe(400);
    repo.recordPayout.mockResolvedValueOnce({ outcome: 'nothing_to_pay' });
    const res = await admin(request(app).post('/payments/admin/payouts')).send({ merchantId: ID });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('nothing_to_pay');
    repo.recordPayout.mockImplementationOnce(boom);
    expect((await admin(request(app).post('/payments/admin/payouts')).send({ merchantId: ID })).status).toBe(500);
  });
});

describe('errores generales', () => {
  it('un JSON mal formado da 400', async () => {
    const res = await user(request(app).post('/payments/orders')).set('Content-Type', 'application/json').send('{malo');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('JSON inválido');
  });
});
