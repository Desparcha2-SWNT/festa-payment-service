// La firma del origen de un reintento debe sobrevivir a un reinicio y a otra réplica con la misma clave,
// y NO valer con otra clave. Cada "proceso" es una instancia nueva del módulo con su INBOX_RETRY_KEY.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'a1b2c3d4'.repeat(8);
const OTHER_KEY = 'f0e1d2c3'.repeat(8);
const original = process.env.INBOX_RETRY_KEY;

async function processWith(key) {
  vi.resetModules();
  process.env.INBOX_RETRY_KEY = key;
  return (await import('../../src/messaging/inboxConsumer.js'))._internal;
}

describe('firma del origen del reintento entre procesos', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    process.env.INBOX_RETRY_KEY = original;
  });

  async function retryFrom(key) {
    const consumer = await processWith(key);
    const sent = [];
    const channel = { ack: vi.fn(), nack: vi.fn(), sendToQueue: vi.fn((q, c, o, cb) => (sent.push({ content: c, options: o }), cb(null))) };
    const msg = { content: Buffer.from(JSON.stringify({ eventId: 'e1' })), properties: { headers: {} }, fields: { exchange: 'festa.event' } };
    await consumer.handleFailure(channel, msg, { eventType: 'x' }, new Error('falla transitoria'));
    const [{ content, options }] = sent;
    // Lo que ve la inbox en la segunda entrega: dead-letter por el exchange por defecto (exchange vacío).
    return { content, properties: options, fields: { exchange: '' } };
  }

  it('el mismo proceso tras un reinicio (misma clave) acepta el reintento pendiente', async () => {
    const retry = await retryFrom(KEY);
    const afterRestart = await processWith(KEY);
    expect(afterRestart.originExchange(retry)).toBe('festa.event');
  });

  it('otra réplica con la misma clave también lo acepta', async () => {
    const retry = await retryFrom(KEY);
    const replica = await processWith(KEY);
    expect(replica.originExchange(retry)).toBe('festa.event');
  });

  it('con otra clave el origen no se acepta (iría a la DLQ): por eso la clave debe ser estable', async () => {
    const retry = await retryFrom(KEY);
    const other = await processWith(OTHER_KEY);
    expect(other.originExchange(retry)).toBe('');
  });
});
