// enqueue escribe la fila del outbox dentro de la transacción recibida.
import { describe, expect, it, vi } from 'vitest';
import { enqueue } from '../src/messaging/outboxRepository.js';

describe('enqueue', () => {
  it('inserta el payload serializado y los ids de trazabilidad (nulos por defecto)', async () => {
    const client = { query: vi.fn().mockResolvedValue({}) };
    await enqueue(client, { exchange: 'festa.payment', routingKey: 'order.approved', payload: { a: 1 } });
    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO outbox/);
    expect(params).toEqual(['festa.payment', 'order.approved', '{"a":1}', null, null]);
  });
});
