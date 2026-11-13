import crypto from 'node:crypto';
import { pool, withTransaction } from '../db/pool.js';
import { enqueue } from '../messaging/outboxRepository.js';
import { config } from '../config.js';
import { priceOrder } from './pricing.js';
import { mapPaymentMethod, referenceFor } from '../wompi/wompi.js';

export const EXCHANGE = 'festa.payment';
// Comprador anonimizado (Ley 1581): las órdenes se conservan por contabilidad sin dato personal.
export const ANONYMOUS_BUYER = '00000000-0000-0000-0000-000000000000';

const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

export function toApi(row) {
  return {
    orderId: row.id,
    reference: row.reference,
    eventId: row.event_id,
    eventTitle: row.title ?? undefined,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    subtotalCents: row.subtotal_cents,
    commissionCents: row.commission_cents,
    totalCents: row.total_cents,
    currency: row.currency,
    status: row.status,
    paymentMethod: row.payment_method ?? undefined,
    expiresAt: iso(row.expires_at),
    approvedAt: row.approved_at ? iso(row.approved_at) : undefined,
    refundedAt: row.refunded_at ? iso(row.refunded_at) : undefined,
    createdAt: iso(row.created_at),
  };
}

async function lockEvent(client, eventId) {
  const { rows } = await client.query('SELECT * FROM event_projection WHERE event_id = $1 FOR UPDATE', [eventId]);
  return rows[0];
}

async function lockOrder(client, where, value) {
  const { rows } = await client.query(`SELECT * FROM orders WHERE ${where} = $1 FOR UPDATE`, [value]);
  return rows[0];
}

function available(event) {
  return event.capacity === null ? Infinity : event.capacity - event.sold - event.held;
}

/**
 * Crea una orden PENDING y retiene los cupos mientras el usuario paga en Wompi
 * (contracts/README.md § Compra de boletas, paso 2). Con el mismo Idempotency-Key devuelve la
 * misma orden en vez de crear otra.
 */
export async function createOrder({ eventId, quantity, buyerId, idempotencyKey = null, correlationId = null }) {
  return withTransaction(async (client) => {
    if (idempotencyKey) {
      const { rows } = await client.query(
        `SELECT o.*, e.title FROM orders o JOIN event_projection e USING (event_id)
         WHERE o.buyer_id = $1 AND o.idempotency_key = $2`,
        [buyerId, idempotencyKey],
      );
      if (rows[0]) return { outcome: 'existing', order: rows[0] };
    }

    const event = await lockEvent(client, eventId);
    if (!event) return { outcome: 'not_found' };
    if (!event.ticketed || event.price_cents <= 0) return { outcome: 'not_ticketed' };
    if (event.status !== 'published' || new Date(event.ends_at) <= new Date()) return { outcome: 'closed' };
    if (event.max_tickets_per_order && quantity > event.max_tickets_per_order) {
      return { outcome: 'too_many', max: event.max_tickets_per_order };
    }
    if (available(event) < quantity) return { outcome: 'sold_out', available: Math.max(available(event), 0) };

    const price = priceOrder(event.price_cents, quantity);
    const orderId = crypto.randomUUID();
    const reference = referenceFor(orderId);
    const expiresAt = new Date(Date.now() + config.reservationHoldMinutes * 60_000);

    const { rows } = await client.query(
      `INSERT INTO orders (id, reference, event_id, organizer_id, merchant_id, buyer_id, idempotency_key, quantity,
         unit_price_cents, subtotal_cents, commission_cents, total_cents, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        orderId, reference, eventId, event.organizer_id, event.merchant_id, buyerId, idempotencyKey, quantity,
        price.unitPriceCents, price.subtotalCents, price.commissionCents, price.totalCents, expiresAt,
      ],
    );
    await client.query('UPDATE event_projection SET held = held + $2, updated_at = now() WHERE event_id = $1', [
      eventId,
      quantity,
    ]);

    const order = { ...rows[0], title: event.title };
    await enqueue(client, {
      exchange: EXCHANGE,
      routingKey: 'order.created',
      payload: {
        orderId,
        eventId,
        buyerId,
        quantity,
        totalCents: price.totalCents,
        currency: 'COP',
        expiresAt: iso(expiresAt),
        createdAt: iso(order.created_at),
      },
      correlationId,
    });
    return { outcome: 'created', order };
  });
}

export async function findOrderById(orderId) {
  const { rows } = await pool.query(
    'SELECT o.*, e.title FROM orders o JOIN event_projection e USING (event_id) WHERE o.id = $1',
    [orderId],
  );
  return rows[0] ?? null;
}

export async function findOrdersByBuyer(buyerId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT o.*, e.title FROM orders o JOIN event_projection e USING (event_id)
     WHERE o.buyer_id = $1 ORDER BY o.created_at DESC LIMIT $2`,
    [buyerId, limit],
  );
  return rows;
}

/** Cotización sin crear nada: precio, comisión y cupos libres. */
export async function quote(eventId, quantity) {
  const { rows } = await pool.query('SELECT * FROM event_projection WHERE event_id = $1', [eventId]);
  const event = rows[0];
  if (!event) return { outcome: 'not_found' };
  if (!event.ticketed) return { outcome: 'not_ticketed' };
  return {
    outcome: 'ok',
    quote: {
      eventId,
      ...priceOrder(event.price_cents, quantity),
      currency: 'COP',
      available: event.capacity === null ? null : Math.max(available(event), 0),
      maxTicketsPerOrder: event.max_tickets_per_order ?? null,
    },
  };
}

// ----------------------------------------------------------------- transiciones

function failedPayload(order, status, reason, transactionId) {
  return {
    orderId: order.id,
    eventId: order.event_id,
    buyerId: order.buyer_id,
    status,
    ...(reason ? { reason: reason.slice(0, 500) } : {}),
    ...(transactionId ? { providerTransactionId: String(transactionId) } : {}),
    failedAt: new Date().toISOString(),
  };
}

/**
 * Aplica el resultado de una transacción de Wompi a la orden con esa referencia. Lo usa el webhook
 * (y la simulación local). Idempotente: una orden que ya no está PENDING no cambia, salvo un
 * APPROVED tardío sobre una orden vencida, que se vende si aún hay cupo o pasa a reembolso.
 */
export async function applyTransaction({ reference, status, amountInCents, transactionId, paymentMethodType, statusMessage }, correlationId = null) {
  return withTransaction(async (client) => {
    const order = await lockOrder(client, 'reference', reference);
    if (!order) return { outcome: 'unknown_reference' };
    if (amountInCents != null && Number(amountInCents) !== order.total_cents) {
      return { outcome: 'amount_mismatch', order };
    }

    const event = await lockEvent(client, order.event_id);

    if (status === 'APPROVED') {
      if (order.status === 'PENDING') {
        await client.query('UPDATE event_projection SET held = GREATEST(held - $2, 0), sold = sold + $2 WHERE event_id = $1', [
          order.event_id,
          order.quantity,
        ]);
      } else if (order.status === 'EXPIRED') {
        // Pago que llegó después de liberar los cupos (p. ej. PSE lento).
        if (available(event) < order.quantity || event.status !== 'published') {
          return requestRefund(client, order, 'admin', correlationId, { transactionId, paymentMethodType });
        }
        await client.query('UPDATE event_projection SET sold = sold + $2 WHERE event_id = $1', [order.event_id, order.quantity]);
      } else {
        return { outcome: 'unchanged', order };
      }

      const { rows } = await client.query(
        `UPDATE orders SET status = 'APPROVED', approved_at = now(), provider_transaction_id = $2,
           payment_method = $3, updated_at = now() WHERE id = $1 RETURNING *`,
        [order.id, String(transactionId ?? ''), mapPaymentMethod(paymentMethodType)],
      );
      const approved = rows[0];
      await enqueue(client, {
        exchange: EXCHANGE,
        routingKey: 'order.approved',
        payload: {
          orderId: approved.id,
          eventId: approved.event_id,
          organizerId: approved.organizer_id,
          ...(approved.merchant_id ? { merchantId: approved.merchant_id } : {}),
          buyerId: approved.buyer_id,
          quantity: approved.quantity,
          unitPriceCents: approved.unit_price_cents,
          subtotalCents: approved.subtotal_cents,
          commissionCents: approved.commission_cents,
          totalCents: approved.total_cents,
          currency: 'COP',
          paymentMethod: approved.payment_method,
          providerTransactionId: approved.provider_transaction_id || approved.reference,
          approvedAt: iso(approved.approved_at),
        },
        correlationId,
      });
      return { outcome: 'approved', order: approved };
    }

    if (['DECLINED', 'VOIDED', 'ERROR'].includes(status)) {
      if (order.status !== 'PENDING') return { outcome: 'unchanged', order };
      await client.query('UPDATE event_projection SET held = GREATEST(held - $2, 0) WHERE event_id = $1', [
        order.event_id,
        order.quantity,
      ]);
      const { rows } = await client.query(
        `UPDATE orders SET status = $2, failure_reason = $3, provider_transaction_id = $4, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [order.id, status, statusMessage ?? null, transactionId ? String(transactionId) : null],
      );
      await enqueue(client, {
        exchange: EXCHANGE,
        routingKey: 'order.failed',
        payload: failedPayload(rows[0], status, statusMessage, transactionId),
        correlationId,
      });
      return { outcome: 'failed', order: rows[0] };
    }

    // PENDING u otro estado intermedio: no hay nada que hacer todavía.
    return { outcome: 'unchanged', order };
  });
}

/** Pasa una orden APPROVED (o un pago tardío) a REFUND_REQUESTED y publica order.refund_requested. */
export async function requestRefund(client, order, reason, correlationId = null, extra = {}, causationId = null) {
  const { rows } = await client.query(
    `UPDATE orders SET status = 'REFUND_REQUESTED', refund_requested_at = now(),
       provider_transaction_id = COALESCE(provider_transaction_id, $2),
       payment_method = COALESCE(payment_method, $3), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [order.id, extra.transactionId ? String(extra.transactionId) : null, extra.paymentMethodType ? mapPaymentMethod(extra.paymentMethodType) : null],
  );
  await enqueue(client, {
    exchange: EXCHANGE,
    routingKey: 'order.refund_requested',
    payload: {
      orderId: order.id,
      eventId: order.event_id,
      buyerId: order.buyer_id,
      amountCents: order.total_cents,
      reason,
      requestedAt: iso(rows[0].refund_requested_at),
    },
    correlationId,
    causationId,
  });
  return { outcome: 'refund_requested', order: rows[0] };
}

/** Vence una orden PENDING: libera los cupos y publica order.expired. Quien llama abre la transacción. */
export async function expireOrder(client, order, { correlationId = null, causationId = null } = {}) {
  await client.query('UPDATE event_projection SET held = GREATEST(held - $2, 0) WHERE event_id = $1', [
    order.event_id,
    order.quantity,
  ]);
  const { rows } = await client.query(
    `UPDATE orders SET status = 'EXPIRED', updated_at = now() WHERE id = $1 RETURNING updated_at`,
    [order.id],
  );
  await enqueue(client, {
    exchange: EXCHANGE,
    routingKey: 'order.expired',
    payload: { orderId: order.id, eventId: order.event_id, buyerId: order.buyer_id, expiredAt: iso(rows[0].updated_at) },
    correlationId,
    causationId,
  });
}

/** Job: vence las órdenes PENDING cuyo tiempo de retención pasó. Devuelve cuántas venció. */
export async function expireDueOrders(limit = 100) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM orders WHERE status = 'PENDING' AND expires_at <= now()
       ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    for (const order of rows) await expireOrder(client, order);
    return rows.length;
  });
}

// ----------------------------------------------------------------- administración

export async function listRefundRequests() {
  const { rows } = await pool.query(
    `SELECT o.*, e.title FROM orders o JOIN event_projection e USING (event_id)
     WHERE o.status = 'REFUND_REQUESTED' ORDER BY o.refund_requested_at`,
  );
  return rows;
}

/** El admin pide a mano el reembolso de una orden aprobada. */
export async function adminRequestRefund(orderId, correlationId) {
  return withTransaction(async (client) => {
    const order = await lockOrder(client, 'id', orderId);
    if (!order) return { outcome: 'not_found' };
    if (order.status !== 'APPROVED') return { outcome: 'conflict' };
    return requestRefund(client, order, 'admin', correlationId);
  });
}

/** El admin registra que hizo el reembolso en Wompi: publica order.refunded y libera los cupos. */
export async function markRefunded(orderId, adminId, reference, correlationId) {
  return withTransaction(async (client) => {
    const order = await lockOrder(client, 'id', orderId);
    if (!order) return { outcome: 'not_found' };
    if (!['REFUND_REQUESTED', 'APPROVED'].includes(order.status)) return { outcome: 'conflict' };
    if (order.payout_id) return { outcome: 'already_paid_out' };

    const wasSold = order.approved_at !== null;
    const { rows } = await client.query(
      `UPDATE orders SET status = 'REFUNDED', refunded_at = now(), refund_reference = $2, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [orderId, reference ?? null],
    );
    if (wasSold) {
      await client.query('UPDATE event_projection SET sold = GREATEST(sold - $2, 0) WHERE event_id = $1', [
        order.event_id,
        order.quantity,
      ]);
    }
    await enqueue(client, {
      exchange: EXCHANGE,
      routingKey: 'order.refunded',
      payload: {
        orderId,
        eventId: order.event_id,
        buyerId: order.buyer_id,
        amountCents: order.total_cents,
        refundedBy: adminId,
        ...(reference ? { reference } : {}),
        refundedAt: iso(rows[0].refunded_at),
      },
      correlationId,
    });
    return { outcome: 'refunded', order: rows[0] };
  });
}

/** Lo que se le debe a cada comercio: órdenes aprobadas de eventos ya terminados, sin liquidar. */
export async function pendingPayouts() {
  const { rows } = await pool.query(
    `SELECT o.merchant_id, o.organizer_id, m.business_name, COUNT(*)::int AS order_count,
       SUM(o.subtotal_cents)::bigint AS amount_cents, MIN(o.approved_at) AS period_from, MAX(o.approved_at) AS period_to
     FROM orders o JOIN event_projection e USING (event_id) LEFT JOIN merchants m ON m.merchant_id = o.merchant_id
     WHERE o.status = 'APPROVED' AND o.payout_id IS NULL AND o.merchant_id IS NOT NULL AND e.ends_at <= now()
     GROUP BY o.merchant_id, o.organizer_id, m.business_name ORDER BY amount_cents DESC`,
  );
  return rows.map((r) => ({
    merchantId: r.merchant_id,
    organizerId: r.organizer_id,
    businessName: r.business_name,
    orderCount: r.order_count,
    amountCents: Number(r.amount_cents),
    periodFrom: iso(r.period_from),
    periodTo: iso(r.period_to),
  }));
}

/**
 * El admin registra la transferencia manual a un comercio: liquida todas sus órdenes aprobadas de
 * eventos terminados (el comercio recibe el subtotal; la comisión es de Festa).
 */
export async function recordPayout(merchantId, adminId, { reference, paidAt }, correlationId) {
  return withTransaction(async (client) => {
    const { rows: orders } = await client.query(
      `SELECT o.* FROM orders o JOIN event_projection e USING (event_id)
       WHERE o.status = 'APPROVED' AND o.payout_id IS NULL AND o.merchant_id = $1 AND e.ends_at <= now()
       FOR UPDATE OF o`,
      [merchantId],
    );
    if (orders.length === 0) return { outcome: 'nothing_to_pay' };

    const amountCents = orders.reduce((sum, o) => sum + o.subtotal_cents, 0);
    const approvedTimes = orders.map((o) => new Date(o.approved_at).getTime());
    const periodFrom = new Date(Math.min(...approvedTimes));
    const periodTo = new Date(Math.max(...approvedTimes));
    const paid = paidAt ? new Date(paidAt) : new Date();

    const { rows } = await client.query(
      `INSERT INTO payouts (merchant_id, organizer_id, amount_cents, order_count, period_from, period_to, reference, recorded_by, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [merchantId, orders[0].organizer_id, amountCents, orders.length, periodFrom, periodTo, reference ?? null, adminId, paid],
    );
    const payout = rows[0];
    await client.query('UPDATE orders SET payout_id = $1, updated_at = now() WHERE id = ANY($2::uuid[])', [
      payout.id,
      orders.map((o) => o.id),
    ]);
    const payload = {
      payoutId: payout.id,
      merchantId,
      organizerId: payout.organizer_id,
      amountCents,
      orderCount: orders.length,
      periodFrom: iso(periodFrom),
      periodTo: iso(periodTo),
      ...(reference ? { reference } : {}),
      recordedBy: adminId,
      paidAt: iso(paid),
    };
    await enqueue(client, { exchange: EXCHANGE, routingKey: 'payout.recorded', payload, correlationId });
    return { outcome: 'recorded', payout: payload };
  });
}

/** Panel del comercio: ventas por evento y liquidaciones recibidas. */
export async function merchantSummary(userId) {
  const { rows: sales } = await pool.query(
    `SELECT e.event_id, e.title, e.starts_at,
       COALESCE(SUM(o.quantity) FILTER (WHERE o.status = 'APPROVED'), 0)::int AS tickets_sold,
       COALESCE(SUM(o.subtotal_cents) FILTER (WHERE o.status = 'APPROVED'), 0)::bigint AS gross_cents,
       COALESCE(SUM(o.subtotal_cents) FILTER (WHERE o.status = 'APPROVED' AND o.payout_id IS NULL), 0)::bigint AS pending_payout_cents
     FROM event_projection e LEFT JOIN orders o USING (event_id)
     WHERE e.organizer_id = $1 AND e.ticketed
     GROUP BY e.event_id, e.title, e.starts_at ORDER BY e.starts_at DESC`,
    [userId],
  );
  const { rows: payouts } = await pool.query(
    'SELECT * FROM payouts WHERE organizer_id = $1 ORDER BY paid_at DESC',
    [userId],
  );
  return {
    events: sales.map((s) => ({
      eventId: s.event_id,
      title: s.title,
      startsAt: iso(s.starts_at),
      ticketsSold: s.tickets_sold,
      grossCents: Number(s.gross_cents),
      pendingPayoutCents: Number(s.pending_payout_cents),
    })),
    payouts: payouts.map((p) => ({
      payoutId: p.id,
      amountCents: p.amount_cents,
      orderCount: p.order_count,
      reference: p.reference,
      paidAt: iso(p.paid_at),
    })),
  };
}
