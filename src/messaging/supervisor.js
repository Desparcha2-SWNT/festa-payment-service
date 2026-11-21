import { connect } from 'amqplib';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { startOutboxPublisher } from './outboxPublisher.js';
import { startInboxConsumer } from './inboxConsumer.js';

/**
 * Conecta a RabbitMQ, arranca el publicador del outbox y el consumidor del inbox, y si la
 * conexión se cae EN CUALQUIER MOMENTO (no solo al arrancar) los vuelve a armar sobre una
 * conexión nueva. Sin esto, un blip de RabbitMQ después de que el servicio ya está arriba lo
 * deja sordo y mudo para siempre — nadie se entera, porque el HTTP sigue respondiendo (Postgres
 * sigue vivo) y el `/health` solo mira el proceso, no esta conexión.
 */
export async function startMessaging({ retryMs = 3000 } = {}) {
  let stopped = false;
  let current = null;

  async function connectOnce() {
    // Revisa `stopped` en cada vuelta: si stop() se pide mientras esto espera el siguiente
    // intento, se sale pronto en vez de seguir reconectando después de "apagado".
    while (!stopped) {
      try {
        return await connect(config.amqpUrl);
      } catch (err) {
        logger.warn({ err }, `no se pudo conectar a RabbitMQ, reintentando en ${retryMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, retryMs));
      }
    }
    return null;
  }

  async function teardown(wiring) {
    if (!wiring) return;
    wiring.publisher.stop();
    await wiring.consumerChannel.close().catch(() => {});
    await wiring.connection.close().catch(() => {});
  }

  async function wire() {
    const connection = await connectOnce();
    if (!connection) return; // se pidió detener mientras reintentaba

    if (stopped) {
      // stop() corrió justo cuando esta conexión (tardía) se abrió: no la uses.
      await connection.close().catch(() => {});
      return;
    }

    const publisher = startOutboxPublisher(connection);
    const consumerChannel = await startInboxConsumer(connection);
    const previous = current;
    current = { connection, publisher, consumerChannel };
    // La anterior se cierra DESPUÉS de armar la nueva, no antes: si seguía viva por el tiempo
    // que sea, nunca quedan las dos publicando/consumiendo el mismo outbox/inbox a la vez.
    await teardown(previous);

    connection.once('close', () => {
      if (stopped) return;
      logger.warn('conexión AMQP cerrada inesperadamente, reconectando');
      wire().catch((err) => logger.error(err, 'no se pudo reconectar a RabbitMQ'));
    });
    connection.on('error', (err) => logger.error(err, 'error en la conexión AMQP'));
  }

  await wire(); // bloquea hasta la primera conexión, igual que antes de este cambio

  return {
    stop: async () => {
      stopped = true;
      await teardown(current);
      current = null;
    },
  };
}
