// El publicador del outbox no debe morir cuando la base falla: sigue reintentando en cada ciclo.
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('startOutboxPublisher: la base falla al tomar una conexión', () => {
  afterEach(() => {
    vi.doUnmock('../src/db/pool.js');
    vi.resetModules();
  });

  it('reintenta en los ciclos siguientes y no deja rechazos sin manejar', async () => {
    vi.resetModules();
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error('base caída'))
      .mockRejectedValueOnce(new Error('base caída'))
      .mockResolvedValue(client);
    vi.doMock('../src/db/pool.js', () => ({ pool: { connect } }));
    const { startOutboxPublisher } = await import('../src/messaging/outboxPublisher.js');

    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const publisher = startOutboxPublisher({ createConfirmChannel: vi.fn().mockResolvedValue({}) }, { intervalMs: 15 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    publisher.stop();
    process.off('unhandledRejection', onUnhandled);

    expect(unhandled).toEqual([]);
    expect(connect.mock.calls.length).toBeGreaterThanOrEqual(3); // siguió intentando tras las dos fallas
    expect(client.release).toHaveBeenCalled(); // y cuando la base volvió, liberó la conexión que tomó
  });

  it('un canal que falla al crearse tampoco deja un rechazo sin manejar', async () => {
    vi.resetModules();
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    vi.doMock('../src/db/pool.js', () => ({ pool: { connect: vi.fn().mockResolvedValue(client) } }));
    const { startOutboxPublisher } = await import('../src/messaging/outboxPublisher.js');

    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const connection = { createConfirmChannel: vi.fn().mockRejectedValue(new Error('conexión cerrada')) };
    const publisher = startOutboxPublisher(connection, { intervalMs: 15 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    publisher.stop();
    process.off('unhandledRejection', onUnhandled);

    expect(unhandled).toEqual([]);
    expect(connection.createConfirmChannel.mock.calls.length).toBeGreaterThan(1); // lo vuelve a crear
  });
});
