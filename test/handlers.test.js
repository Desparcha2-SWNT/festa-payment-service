// Manejadores de mensajes consumidos (event.*, merchant.*, account.deleted) con un cliente de
// Postgres simulado: se verifica qué consultas emiten y qué órdenes vencen o reembolsan.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const repo = vi.hoisted(() => ({
  ANONYMOUS_BUYER: '00000000-0000-0000-0000-000000000000',
  expireOrder: vi.fn(),
  lockBuyer: vi.fn(),
  requestRefund: vi.fn(),
}));
vi.mock('../src/orders/repository.js', () => repo);
const { handlers } = await import('../src/messaging/handlers.js');

const EVENT = '6f1c2b8e-3a1d-4c3e-9b0a-1f2e3d4c5b6a';
const ENVELOPE = { eventId: 'msg-1' };

/** Cliente que responde según el SQL: `answers` es una lista [regex, respuesta]. */
function fakeClient(answers = []) {
  return {
    query: vi.fn(async (sql) => {
      for (const [re, res] of answers) if (re.test(sql)) return res;
      return { rows: [], rowCount: 0 };
    }),
  };
}
const sqls = (client) => client.query.mock.calls.map(([sql]) => sql);

const snapshot = {
  eventId: EVENT,
  organizerId: 'org',
  title: 'Concierto',
  startsAt: '2026-12-01T20:00:00Z',
  endsAt: '2026-12-01T23:00:00Z',
  capacity: 100,
  ticketed: true,
  priceCents: 5000000,
  status: 'published',
  version: 3,
};

beforeEach(() => vi.clearAllMocks());

describe('event.published / event.updated', () => {
  it('guarda el snapshot con versión y valores nulos por defecto', async () => {
    const client = fakeClient();
    await handlers['event.published'](snapshot, client, ENVELOPE);
    const [sql, params] = client.query.mock.calls[1];
    expect(sql).toMatch(/INSERT INTO event_projection/);
    expect(sql).toMatch(/WHERE event_projection.version < EXCLUDED.version/);
    expect(params[0]).toBe(EVENT);
    expect(params[2]).toBeNull(); // merchantId ausente
    expect(params[9]).toBeNull(); // maxTicketsPerOrder ausente
    expect(params[11]).toBe(3);
  });

  it('no reabre un evento cerrado con un snapshot retrasado', async () => {
    const client = fakeClient([[/FROM closed_events/, { rows: [{}], rowCount: 1 }]]);
    await handlers['event.updated'](snapshot, client, ENVELOPE);
    expect(client.query).toHaveBeenCalledTimes(1);
  });
});

describe('event.expired', () => {
  it('cierra el evento y vence sus órdenes pendientes con el mensaje como causa', async () => {
    const pending = [{ id: 'o1' }, { id: 'o2' }];
    const client = fakeClient([[/status = 'PENDING'/, { rows: pending }]]);
    await handlers['event.expired']({ eventId: EVENT }, client, ENVELOPE);

    expect(sqls(client)[0]).toMatch(/INSERT INTO closed_events/);
    expect(client.query.mock.calls[0][1]).toEqual([EVENT, 'expired']);
    expect(sqls(client).some((s) => /SET status = 'expired'/.test(s))).toBe(true);
    expect(repo.expireOrder).toHaveBeenCalledTimes(2);
    expect(repo.expireOrder).toHaveBeenCalledWith(client, pending[0], { causationId: 'msg-1' });
    expect(repo.requestRefund).not.toHaveBeenCalled();
  });
});

describe('event.cancelled', () => {
  it('vence las pendientes y pide reembolso de las aprobadas', async () => {
    const client = fakeClient([
      [/status = 'PENDING'/, { rows: [{ id: 'p1' }] }],
      [/status = 'APPROVED'/, { rows: [{ id: 'a1' }, { id: 'a2' }] }],
    ]);
    await handlers['event.cancelled']({ eventId: EVENT, version: 7 }, client, ENVELOPE);

    expect(client.query.mock.calls[0][1]).toEqual([EVENT, 'cancelled']);
    const update = client.query.mock.calls.find(([s]) => /SET status = 'cancelled'/.test(s));
    expect(update[1]).toEqual([EVENT, 7]);
    expect(repo.expireOrder).toHaveBeenCalledWith(client, { id: 'p1' }, { causationId: 'msg-1' });
    expect(repo.requestRefund).toHaveBeenCalledTimes(2);
    expect(repo.requestRefund).toHaveBeenCalledWith(client, { id: 'a1' }, 'event_cancelled', null, {}, 'msg-1');
  });
});

describe('merchant.verified / merchant.updated', () => {
  it('usa verifiedAt cuando viene', async () => {
    const client = fakeClient();
    await handlers['merchant.verified']({ merchantId: 'm', userId: 'u', businessName: 'Bar', verifiedAt: 'v', updatedAt: 'x' }, client);
    expect(client.query.mock.calls[0][1]).toEqual(['m', 'u', 'Bar', 'v']);
  });

  it('cae a updatedAt si no hay verifiedAt', async () => {
    const client = fakeClient();
    await handlers['merchant.updated']({ merchantId: 'm', userId: 'u', businessName: 'Bar', updatedAt: 'x' }, client);
    expect(client.query.mock.calls[0][1]).toEqual(['m', 'u', 'Bar', 'x']);
  });
});

describe('account.deleted', () => {
  it('bloquea al comprador, vence pendientes, deja lápida y anonimiza outbox y órdenes', async () => {
    const client = fakeClient([[/status = 'PENDING'/, { rows: [{ id: 'p1' }] }]]);
    await handlers['account.deleted']({ userId: 'u1' }, client, ENVELOPE);

    expect(repo.lockBuyer).toHaveBeenCalledWith(client, 'u1');
    expect(repo.expireOrder).toHaveBeenCalledWith(client, { id: 'p1' }, { causationId: 'msg-1' });
    const all = sqls(client);
    const tomb = all.findIndex((s) => /INSERT INTO deleted_accounts/.test(s));
    const outbox = all.findIndex((s) => /UPDATE outbox/.test(s));
    const orders = all.findIndex((s) => /UPDATE orders SET buyer_id/.test(s));
    expect(tomb).toBeGreaterThan(0);
    expect(outbox).toBeGreaterThan(tomb);
    expect(orders).toBeGreaterThan(outbox);
    expect(client.query.mock.calls[outbox][1]).toEqual(['u1', repo.ANONYMOUS_BUYER]);
    expect(client.query.mock.calls[orders][0]).toMatch(/idempotency_key = NULL/);
  });
});
