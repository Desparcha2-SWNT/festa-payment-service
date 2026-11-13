import { withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getSchemaRegistry } from './schemaRegistry.js';
import { handlers } from './handlers.js';

const QUEUE = 'payment-service.inbox';
const RETRY_QUEUE = 'payment-service.inbox.retry';
const MAX_RETRIES = 3;

/**
 * Consume `payment-service.inbox` siguiendo contracts/README.md § Consumir: valida el sobre y
 * `data` contra los esquemas reales (y que el productor declarado sea el dueño real de ese
 * eventType), es idempotente (tabla processed_events), reintenta errores transitorios vía
 * inbox.retry y manda a la DLQ los permanentes (dato inválido, productor falso o reintentos
 * agotados).
 *
 * Usa un canal CON confirms: encolar el reintento (`channel.sendToQueue` en handleFailure)
 * espera la confirmación del broker antes de hacer `ack` del mensaje original. Sin eso, si
 * RabbitMQ se cae justo entre las dos operaciones, el original queda confirmado y el
 * reintento se pierde sin que nadie se entere.
 */
export async function startInboxConsumer(connection) {
  const registry = getSchemaRegistry(config.contractsDir);
  const channel = await connection.createConfirmChannel();
  await channel.prefetch(10);

  await channel.consume(QUEUE, (msg) => {
    if (!msg) return;
    handle(channel, msg, registry).catch((err) => logger.error(err, 'error inesperado manejando un mensaje del inbox'));
  });

  return channel;
}

async function handle(channel, msg, registry) {
  let envelope;
  try {
    envelope = JSON.parse(msg.content.toString());
  } catch (err) {
    // Sin separar esto del resto, el mensaje queda sin ack/nack y, con prefetch 10, el
    // consumidor se atasca después de 10 mensajes corruptos.
    logger.error({ err }, 'mensaje del inbox no es JSON, va directo a la DLQ');
    return channel.nack(msg, false, false);
  }

  if (!registry.validateEnvelope(envelope)) {
    logger.error({ errors: registry.validateEnvelope.errors }, 'el sobre no cumple envelope.schema.json, va directo a la DLQ');
    return channel.nack(msg, false, false);
  }

  // Capa extra de defensa: hoy todos los servicios comparten un único usuario de RabbitMQ
  // (ver festa-infra), así que RabbitMQ por sí solo no impide que cualquiera publique un
  // mensaje bien formado con un `producer`/exchange ajeno. Ninguno de los dos es retryable:
  // el mensaje nunca va a dejar de estar mal.
  const expectedProducer = registry.getExpectedProducer(envelope.eventType);
  if (expectedProducer && envelope.producer !== expectedProducer) {
    logger.error(
      { expectedProducer, actual: envelope.producer, eventType: envelope.eventType },
      'el productor declarado no es el dueño de este eventType, va directo a la DLQ',
    );
    return channel.nack(msg, false, false);
  }

  const expectedExchange = registry.getExpectedExchange(envelope.eventType);
  if (expectedExchange && msg.fields.exchange !== expectedExchange) {
    logger.error(
      { expectedExchange, actual: msg.fields.exchange, eventType: envelope.eventType },
      'llegó por un exchange distinto al que declara su esquema, va directo a la DLQ',
    );
    return channel.nack(msg, false, false);
  }

  const validateData = registry.getDataValidator(envelope.eventType);
  if (validateData && !validateData(envelope.data)) {
    // Dato inválido es un error PERMANENTE (contracts/README.md § Consumir): si esto entrara
    // al handler, fallaría contra una restricción de la BD y se trataría como falla transitoria
    // (reintentos), cuando en realidad el mensaje nunca va a poder procesarse.
    logger.error(
      { errors: validateData.errors, eventType: envelope.eventType },
      '`data` no cumple su esquema, va directo a la DLQ',
    );
    return channel.nack(msg, false, false);
  }

  const handler = handlers[envelope.eventType];
  if (!handler) {
    logger.info({ eventType: envelope.eventType }, 'sin handler para este tipo de evento todavía, se confirma sin efecto');
    return channel.ack(msg);
  }

  try {
    await withTransaction(async (client) => {
      const already = await client.query('SELECT 1 FROM processed_events WHERE event_id = $1', [envelope.eventId]);
      if (already.rowCount > 0) return; // duplicado: no se repite el efecto

      await handler(envelope.data, client, envelope);
      await client.query(
        'INSERT INTO processed_events (event_id, event_type) VALUES ($1, $2)',
        [envelope.eventId, envelope.eventType],
      );
    });
    channel.ack(msg);
  } catch (err) {
    await handleFailure(channel, msg, envelope, err);
  }
}

async function handleFailure(channel, msg, envelope, err) {
  const rawRetryCount = msg.properties.headers?.['x-retry-count'] ?? 0;
  const retryCount = Number(rawRetryCount);

  // `Number('algo-raro')` es NaN, y NaN >= MAX_RETRIES siempre da false: sin esto, un header
  // corrupto o forjado (mismo problema de fondo que no separar exchange/productor del mensaje)
  // reintentaría para siempre en vez de agotarse. Negativo tampoco es válido.
  if (!Number.isInteger(retryCount) || retryCount < 0) {
    logger.error({ rawRetryCount, eventType: envelope.eventType }, 'x-retry-count inválido, va directo a la DLQ');
    return channel.nack(msg, false, false);
  }

  if (retryCount >= MAX_RETRIES) {
    logger.error({ err, eventType: envelope.eventType, retryCount }, 'reintentos agotados, va a la DLQ');
    return channel.nack(msg, false, false);
  }

  logger.warn({ err, eventType: envelope.eventType, retryCount }, 'falla transitoria, se reintenta');
  try {
    await new Promise((resolve, reject) => {
      channel.sendToQueue(
        RETRY_QUEUE,
        msg.content,
        { ...msg.properties, headers: { ...msg.properties.headers, 'x-retry-count': retryCount + 1 } },
        (publishErr) => (publishErr ? reject(publishErr) : resolve()),
      );
    });
    // Solo se confirma el original una vez el broker confirmó que recibió el reintento.
    channel.ack(msg);
  } catch (publishErr) {
    // No se sabe si el reintento llegó: no se hace ack ni nack. Si la conexión/canal se cayó
    // (lo más probable aquí), RabbitMQ va a redeliverlo solo cuando el consumidor reconecte;
    // processed_events ya cubre que el reintento llegue dos veces.
    logger.error({ err: publishErr }, 'no se pudo confirmar el reintento, se deja el mensaje sin confirmar');
  }
}

// Export solo para pruebas.
export const _internal = { handlers, handle, handleFailure };
