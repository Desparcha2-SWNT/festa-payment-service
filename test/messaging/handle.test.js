// Prueba el despacho de handle() (sobre -> validar -> verificar productor/exchange -> validar
// data -> handler) con un canal y un registro de esquemas simulados, sin RabbitMQ ni Postgres.
import { describe, expect, it, vi } from 'vitest';
import { _internal } from '../../src/messaging/inboxConsumer.js';

function fakeChannel() {
  return { ack: vi.fn(), nack: vi.fn(), sendToQueue: vi.fn() };
}

function fakeRegistry({ validEnvelope = true, dataValidator, expectedProducer, expectedExchange } = {}) {
  const validateEnvelope = vi.fn().mockReturnValue(validEnvelope);
  validateEnvelope.errors = validEnvelope ? null : [{ message: 'sobre inválido' }];
  return {
    validateEnvelope,
    getExpectedProducer: vi.fn().mockReturnValue(expectedProducer),
    getExpectedExchange: vi.fn().mockReturnValue(expectedExchange),
    getDataValidator: vi.fn().mockReturnValue(dataValidator),
  };
}

function msgWith(envelope, exchange = 'festa.user') {
  return { content: Buffer.from(JSON.stringify(envelope)), properties: { headers: {} }, fields: { exchange } };
}

describe('handle (despacho del inbox)', () => {
  it('manda a la DLQ un mensaje que no es JSON', async () => {
    const channel = fakeChannel();
    const registry = fakeRegistry();
    const msg = { content: Buffer.from('esto no es json'), properties: { headers: {} }, fields: {} };

    await _internal.handle(channel, msg, registry);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('manda a la DLQ un sobre que no cumple envelope.schema.json', async () => {
    const channel = fakeChannel();
    const registry = fakeRegistry({ validEnvelope: false });
    const msg = msgWith({ eventType: 'merchant.verified' });

    await _internal.handle(channel, msg, registry);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
  });

  it('manda a la DLQ si el productor declarado no es el dueño real del eventType', async () => {
    const channel = fakeChannel();
    const registry = fakeRegistry({ expectedProducer: 'user-service', expectedExchange: 'festa.user' });
    const msg = msgWith({ eventId: '1', eventType: 'merchant.verified', producer: 'payment-service', data: {} });

    await _internal.handle(channel, msg, registry);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('manda a la DLQ si llegó por un exchange distinto al que declara su esquema', async () => {
    const channel = fakeChannel();
    const registry = fakeRegistry({ expectedProducer: 'user-service', expectedExchange: 'festa.user' });
    // producer correcto, pero alguien lo publicó en el exchange equivocado.
    const msg = msgWith({ eventId: '1', eventType: 'merchant.verified', producer: 'user-service', data: {} }, 'festa.auth');

    await _internal.handle(channel, msg, registry);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('manda a la DLQ si `data` no cumple su esquema', async () => {
    const channel = fakeChannel();
    const dataValidator = vi.fn().mockReturnValue(false);
    dataValidator.errors = [{ message: 'falta businessName' }];
    const registry = fakeRegistry({ expectedProducer: 'user-service', expectedExchange: 'festa.user', dataValidator });
    const msg = msgWith({ eventId: '1', eventType: 'merchant.verified', producer: 'user-service', data: {} });

    await _internal.handle(channel, msg, registry);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
  });

  it('confirma sin efecto un eventType válido sin handler todavía (p. ej. attendance.confirmed)', async () => {
    const channel = fakeChannel();
    const dataValidator = vi.fn().mockReturnValue(true);
    const registry = fakeRegistry({ expectedProducer: 'booking-service', expectedExchange: 'festa.booking', dataValidator });
    const msg = msgWith({ eventId: '1', eventType: 'attendance.confirmed', producer: 'booking-service', data: {} }, 'festa.booking');

    await _internal.handle(channel, msg, registry);

    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(channel.nack).not.toHaveBeenCalled();
  });
});

describe('handleFailure (reintentos)', () => {
  // Number('algo-raro') es NaN, y NaN >= MAX_RETRIES siempre da false: sin validar esto, un
  // x-retry-count corrupto o forjado reintentaría para siempre en vez de agotarse.
  it.each(['no-es-un-numero', -1, 'NaN', '3.5'])('manda a la DLQ si x-retry-count es inválido (%s)', async (bad) => {
    const channel = fakeChannel();
    const msg = { content: Buffer.from('{}'), properties: { headers: { 'x-retry-count': bad } } };

    await _internal.handleFailure(channel, msg, { eventType: 'merchant.verified' }, new Error('falla transitoria'));

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.sendToQueue).not.toHaveBeenCalled();
  });

  it('reintenta normalmente con un x-retry-count válido', async () => {
    const channel = fakeChannel();
    channel.sendToQueue.mockImplementation((queue, content, options, cb) => cb(null));
    const msg = { content: Buffer.from('{}'), properties: { headers: { 'x-retry-count': 1 } } };

    await _internal.handleFailure(channel, msg, { eventType: 'merchant.verified' }, new Error('falla transitoria'));

    expect(channel.sendToQueue).toHaveBeenCalledOnce();
    expect(channel.sendToQueue.mock.calls[0][2].headers['x-retry-count']).toBe(2);
    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('manda a la DLQ si ya se agotaron los reintentos', async () => {
    const channel = fakeChannel();
    const msg = { content: Buffer.from('{}'), properties: { headers: { 'x-retry-count': 3 } } };

    await _internal.handleFailure(channel, msg, { eventType: 'merchant.verified' }, new Error('falla transitoria'));

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.sendToQueue).not.toHaveBeenCalled();
  });
});
