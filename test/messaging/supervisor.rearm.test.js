// RabbitMQ se reinicia sin disco en AWS: la reconexión llega antes que sus colas y el primer armado
// falla. El supervisor debe reintentar el armado completo hasta tener el consumidor otra vez.
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  connect: vi.fn(),
  startOutboxPublisher: vi.fn(() => ({ stop: vi.fn() })),
  startInboxConsumer: vi.fn(),
}));

vi.mock('amqplib', () => ({ connect: h.connect }));
vi.mock('../../src/messaging/outboxPublisher.js', () => ({ startOutboxPublisher: h.startOutboxPublisher }));
vi.mock('../../src/messaging/inboxConsumer.js', () => ({ startInboxConsumer: h.startInboxConsumer }));

const { startMessaging } = await import('../../src/messaging/supervisor.js');

function fakeConnection() {
  const conn = new EventEmitter();
  conn.close = vi.fn().mockResolvedValue();
  return conn;
}

describe('startMessaging: rearmado tras un reinicio de RabbitMQ', () => {
  it('si la cola todavía no existe al reconectar, reintenta hasta armar el consumidor', async () => {
    const conn1 = fakeConnection();
    const sinCola = fakeConnection();
    const conn3 = fakeConnection();
    h.connect.mockResolvedValueOnce(conn1).mockResolvedValueOnce(sinCola).mockResolvedValueOnce(conn3);
    h.startInboxConsumer
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue() })
      .mockRejectedValueOnce(new Error("NOT_FOUND - no queue"))
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue() });

    const messaging = await startMessaging({ retryMs: 10 });
    conn1.emit('close'); // RabbitMQ se reinicia

    // Tercera conexión: la segunda falló al consumir y se cerró, y el supervisor no se rindió.
    await vi.waitFor(() => expect(h.startInboxConsumer).toHaveBeenCalledTimes(3));
    expect(h.connect).toHaveBeenCalledTimes(3);
    expect(sinCola.close).toHaveBeenCalledTimes(1);

    await messaging.stop();
    expect(conn3.close).toHaveBeenCalledTimes(1);
  });
});
