import { ANONYMOUS_BUYER, expireOrder, lockBuyer, requestRefund } from '../orders/repository.js';

// Un handler por tipo de mensaje consumido (ver contracts/README.md § Qué consume cada servicio).
// Recibe `data`, el `client` de una transacción ya abierta y el `envelope` completo.

/** Marca el evento como cerrado: un snapshot que llegue después no lo vuelve a abrir (ver migración 006). */
async function closeEvent(client, eventId, status) {
  await client.query(
    'INSERT INTO closed_events (event_id, status) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING',
    [eventId, status],
  );
}

/** event.published / event.updated traen el snapshot completo; se ignora uno más viejo que el guardado. */
async function upsertSnapshot(data, client) {
  const { rowCount } = await client.query('SELECT 1 FROM closed_events WHERE event_id = $1', [data.eventId]);
  if (rowCount > 0) return; // evento cancelado o expirado: un snapshot retrasado no lo reabre
  await client.query(
    `INSERT INTO event_projection (event_id, organizer_id, merchant_id, title, starts_at, ends_at, capacity,
       ticketed, price_cents, max_tickets_per_order, status, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (event_id) DO UPDATE SET
       organizer_id = EXCLUDED.organizer_id, merchant_id = EXCLUDED.merchant_id, title = EXCLUDED.title,
       starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, capacity = EXCLUDED.capacity,
       ticketed = EXCLUDED.ticketed, price_cents = EXCLUDED.price_cents,
       max_tickets_per_order = EXCLUDED.max_tickets_per_order, status = EXCLUDED.status,
       version = EXCLUDED.version, updated_at = now()
     WHERE event_projection.version < EXCLUDED.version`,
    [
      data.eventId, data.organizerId, data.merchantId ?? null, data.title, data.startsAt, data.endsAt, data.capacity,
      data.ticketed, data.priceCents, data.maxTicketsPerOrder ?? null, data.status, data.version,
    ],
  );
}

/** Vence las órdenes PENDING de un evento que ya no se puede vender. */
async function expirePendingOrders(client, eventId, causationId) {
  const { rows } = await client.query(`SELECT * FROM orders WHERE event_id = $1 AND status = 'PENDING' FOR UPDATE`, [eventId]);
  for (const order of rows) await expireOrder(client, order, { causationId });
}

async function upsertMerchant(data, client) {
  await client.query(
    `INSERT INTO merchants (merchant_id, user_id, business_name, verified_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (merchant_id) DO UPDATE SET user_id = EXCLUDED.user_id, business_name = EXCLUDED.business_name,
       updated_at = now()`,
    [data.merchantId, data.userId, data.businessName, data.verifiedAt ?? data.updatedAt],
  );
}

export const handlers = {
  'event.published': upsertSnapshot,
  'event.updated': upsertSnapshot,

  // Cerrar la venta y expirar órdenes pendientes.
  'event.expired': async (data, client, envelope) => {
    await closeEvent(client, data.eventId, 'expired');
    await client.query(`UPDATE event_projection SET status = 'expired', updated_at = now() WHERE event_id = $1`, [data.eventId]);
    await expirePendingOrders(client, data.eventId, envelope.eventId);
  },

  // contracts/README.md § Evento cancelado: deja de vender y pide reembolso de las órdenes aprobadas.
  'event.cancelled': async (data, client, envelope) => {
    await closeEvent(client, data.eventId, 'cancelled');
    await client.query(
      `UPDATE event_projection SET status = 'cancelled', version = GREATEST(version, $2), updated_at = now() WHERE event_id = $1`,
      [data.eventId, data.version],
    );
    await expirePendingOrders(client, data.eventId, envelope.eventId);
    const { rows } = await client.query(`SELECT * FROM orders WHERE event_id = $1 AND status = 'APPROVED' FOR UPDATE`, [data.eventId]);
    for (const order of rows) {
      await requestRefund(client, order, 'event_cancelled', null, {}, envelope.eventId);
    }
  },

  'merchant.verified': upsertMerchant,
  'merchant.updated': upsertMerchant,

  // Ley 1581: las órdenes se conservan por contabilidad, pero sin el comprador. Las pendientes vencen y los
  // mensajes sin publicar se anonimizan (no se borran).
  'account.deleted': async (data, client, envelope) => {
    await lockBuyer(client, data.userId); // ninguna orden nueva de esta cuenta entra mientras se borra
    const { rows } = await client.query(`SELECT * FROM orders WHERE buyer_id = $1 AND status = 'PENDING' FOR UPDATE`, [data.userId]);
    for (const order of rows) await expireOrder(client, order, { causationId: envelope.eventId });
    // Lápida: un JWT vigente de la cuenta borrada no puede crear órdenes nuevas (ver createOrder).
    await client.query('INSERT INTO deleted_accounts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [data.userId]);
    // El outbox también lleva el buyerId en el payload. Ningún mensaje se borra (un order.approved sin
    // publicar dejaría un cobro sin pase ni reembolso): todos, enviados o no, se anonimizan con el comprador
    // anónimo de las órdenes, que sigue cumpliendo el contrato. Sin filtrar por sent_at: si el publicador
    // tiene la fila bloqueada, este UPDATE espera a que termine y la anonimiza igual (la copia que ya salió
    // la borra cada consumidor con su propio account.deleted).
    await client.query(
      `UPDATE outbox SET payload = jsonb_set(payload, '{buyerId}', to_jsonb($2::text))
        WHERE payload->>'buyerId' = $1`,
      [data.userId, ANONYMOUS_BUYER],
    );
    await client.query('UPDATE orders SET buyer_id = $2, idempotency_key = NULL WHERE buyer_id = $1', [data.userId, ANONYMOUS_BUYER]);
  },
};
