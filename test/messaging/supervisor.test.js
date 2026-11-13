// Reproduce el hallazgo de la revisión: al reconectar, supervisor.js reemplazaba `current` sin
// detener el publicador/consumidor anteriores -> dos timers publicando el mismo outbox a la vez.
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const publisherStop = vi.fn();
  const consumerChannelClose = vi.fn().mockResolvedValue();
  return {
    connect: vi.fn(),
    publisherStop,
    consumerChannelClose,
    startOutboxPublisher: vi.fn(() => ({ stop: publisherStop })),
    startInboxConsumer: vi.fn().mockResolvedValue({ close: consumerChannelClose }),
  };
});

vi.mock('amqplib', () => ({ connect: h.connect }));
vi.mock('../../src/messaging/outboxPublisher.js', () => ({ startOutboxPublisher: h.startOutboxPublisher }));
vi.mock('../../src/messaging/inboxConsumer.js', () => ({ startInboxConsumer: h.startInboxConsumer }));

const { startMessaging } = await import('../../src/messaging/supervisor.js');

function fakeConnection() {
  const conn = new EventEmitter();
  conn.close = vi.fn().mockResolvedValue();
  return conn;
}

describe('startMessaging', () => {
  it('al reconectar, cierra la conexión/publicador/consumidor anteriores antes de seguir', async () => {
    const conn1 = fakeConnection();
    const conn2 = fakeConnection();
    h.connect.mockResolvedValueOnce(conn1).mockResolvedValueOnce(conn2);

    const messaging = await startMessaging();
    expect(h.startOutboxPublisher).toHaveBeenCalledTimes(1);
    expect(h.startInboxConsumer).toHaveBeenCalledTimes(1);

    conn1.emit('close'); // simula que RabbitMQ se cae
    await vi.waitFor(() => expect(h.startOutboxPublisher).toHaveBeenCalledTimes(2));

    // El publicador y el canal VIEJOS se detuvieron -- no quedan dos corriendo a la vez.
    expect(h.publisherStop).toHaveBeenCalledTimes(1);
    expect(h.consumerChannelClose).toHaveBeenCalledTimes(1);
    expect(conn1.close).toHaveBeenCalledTimes(1);

    await messaging.stop();
    // stop() también apaga la wiring ACTUAL (la de conn2), no la vieja otra vez.
    expect(h.publisherStop).toHaveBeenCalledTimes(2);
    expect(conn2.close).toHaveBeenCalledTimes(1);
  });

  it('stop() detiene los reintentos de reconexión pendientes', async () => {
    const conn1 = fakeConnection();
    h.connect.mockResolvedValueOnce(conn1).mockRejectedValue(new Error('rabbitmq caído'));

    const messaging = await startMessaging({ retryMs: 10 });
    conn1.emit('close'); // dispara una reconexión que va a fallar en bucle (retryMs=10)

    // Deja que al menos un intento fallido pase (connect ya fue llamado 2 veces: la inicial + 1 reintento).
    await vi.waitFor(() => expect(h.connect.mock.calls.length).toBeGreaterThanOrEqual(2));

    await messaging.stop();
    const callsAtStop = h.connect.mock.calls.length;

    // Si todavía estuviera reintentando, seguirían llegando llamadas a connect() con el tiempo.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.connect.mock.calls.length).toBe(callsAtStop);
  });
});
