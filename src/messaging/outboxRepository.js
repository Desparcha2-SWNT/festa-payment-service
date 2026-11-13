/**
 * Encola una fila en `outbox` dentro de la transacción de `client` (ver contracts/README.md
 * § Publicar). Exactamente uno de `correlationId`/`causationId` tiene sentido según el origen:
 * una petición HTTP pasa `correlationId` (el X-Correlation-ID de Kong); un mensaje consumido
 * pasa `causationId` (el eventId de ese mensaje).
 */
export async function enqueue(client, { exchange, routingKey, payload, correlationId = null, causationId = null }) {
  await client.query(
    `INSERT INTO outbox (exchange, routing_key, payload, correlation_id, causation_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [exchange, routingKey, JSON.stringify(payload), correlationId, causationId],
  );
}
