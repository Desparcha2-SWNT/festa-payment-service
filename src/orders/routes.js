import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { checkoutData } from '../wompi/wompi.js';
import { config } from '../config.js';
import {
  adminRequestRefund,
  applyTransaction,
  createOrder,
  findOrderById,
  findOrdersByBuyer,
  listRefundRequests,
  markRefunded,
  merchantSummary,
  pendingPayouts,
  quote,
  recordPayout,
  toApi,
} from './repository.js';

export const paymentsRouter = Router();

// Kong ya limita por usuario (30/min); este segundo límite por IP no depende del gateway.
paymentsRouter.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
paymentsRouter.use(requireAuth);

const uuid = z.uuid();
const correlation = (req) => req.headers['x-correlation-id'] ?? null;

function badRequest(res, error) {
  return res.status(400).json({ error: 'cuerpo inválido', issues: z.treeifyError(error) });
}

function validId(req, res, next) {
  if (!uuid.safeParse(req.params.id).success) return res.status(400).json({ error: 'id inválido' });
  next();
}

const ORDER_ERRORS = {
  not_found: [404, 'evento no encontrado'],
  not_ticketed: [409, 'este evento no vende boletas'],
  closed: [409, 'el evento ya no está a la venta'],
  too_many: [409, 'superas el máximo de boletas por orden'],
  sold_out: [409, 'no quedan boletas suficientes'],
};

function sendOutcome(res, table, result) {
  const [status, error] = table[result.outcome];
  return res.status(status).json({ error, code: result.outcome, ...(result.max ? { max: result.max } : {}), ...(result.available !== undefined ? { available: result.available } : {}) });
}

const quantitySchema = z.coerce.number().int().min(1).max(10);

// Cotización: precio, comisión de Festa y cupos libres antes de comprar.
paymentsRouter.get('/events/:id/quote', validId, async (req, res, next) => {
  const quantity = quantitySchema.safeParse(req.query.quantity ?? 1);
  if (!quantity.success) return res.status(400).json({ error: 'quantity inválida' });
  try {
    const result = await quote(req.params.id, quantity.data);
    if (result.outcome !== 'ok') return sendOutcome(res, ORDER_ERRORS, result);
    res.json(result.quote);
  } catch (err) {
    next(err);
  }
});

const createOrderSchema = z.object({ eventId: z.uuid(), quantity: quantitySchema }).strict();

// RF11: crea la orden, retiene los cupos y devuelve los datos del checkout de Wompi.
paymentsRouter.post('/orders', async (req, res, next) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  const idempotencyKey = req.headers['idempotency-key'];
  if (idempotencyKey !== undefined && !/^[\w-]{8,100}$/.test(idempotencyKey)) {
    return res.status(400).json({ error: 'Idempotency-Key inválido' });
  }

  try {
    const result = await createOrder({
      ...parsed.data,
      buyerId: req.auth.userId,
      idempotencyKey: idempotencyKey ?? null,
      correlationId: correlation(req),
    });
    if (!result.order) return sendOutcome(res, ORDER_ERRORS, result);
    const order = result.order;
    res.status(result.outcome === 'created' ? 201 : 200).json({
      ...toApi(order),
      checkout: order.status === 'PENDING' ? checkoutData({ reference: order.reference, amountInCents: order.total_cents }) : undefined,
    });
  } catch (err) {
    next(err);
  }
});

paymentsRouter.get('/orders/mine', async (req, res, next) => {
  try {
    res.json({ items: (await findOrdersByBuyer(req.auth.userId)).map(toApi) });
  } catch (err) {
    next(err);
  }
});

paymentsRouter.get('/orders/:id', validId, async (req, res, next) => {
  try {
    const order = await findOrderById(req.params.id);
    if (!order || (order.buyer_id !== req.auth.userId && req.auth.role !== 'admin')) {
      return res.status(404).json({ error: 'orden no encontrada' });
    }
    res.json({
      ...toApi(order),
      checkout: order.status === 'PENDING' ? checkoutData({ reference: order.reference, amountInCents: order.total_cents }) : undefined,
    });
  } catch (err) {
    next(err);
  }
});

// Solo en desarrollo (PAYMENTS_ALLOW_SIMULATION=true): simula la respuesta de Wompi para probar el
// flujo completo (boletas, QR, notificaciones) sin pasarela real.
const simulateSchema = z.object({ status: z.enum(['APPROVED', 'DECLINED', 'VOIDED', 'ERROR']) }).strict();
paymentsRouter.post('/orders/:id/simulate', validId, async (req, res, next) => {
  if (process.env.PAYMENTS_ALLOW_SIMULATION !== 'true' || config.wompi.env === 'production') {
    return res.status(404).json({ error: 'no disponible' });
  }
  const parsed = simulateSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  try {
    const order = await findOrderById(req.params.id);
    if (!order || order.buyer_id !== req.auth.userId) return res.status(404).json({ error: 'orden no encontrada' });
    const result = await applyTransaction(
      {
        reference: order.reference,
        status: parsed.data.status,
        amountInCents: order.total_cents,
        transactionId: `sim-${Date.now()}`,
        paymentMethodType: 'CARD',
        statusMessage: parsed.data.status === 'APPROVED' ? null : 'simulado',
      },
      correlation(req),
    );
    res.json({ outcome: result.outcome, ...(result.order ? toApi(result.order) : {}) });
  } catch (err) {
    next(err);
  }
});

// Panel de ventas del comercio (complementa RF15): boletas vendidas y lo pendiente por liquidar.
paymentsRouter.get('/merchants/me/summary', async (req, res, next) => {
  try {
    res.json(await merchantSummary(req.auth.userId));
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------- admin
const admin = Router();
admin.use(requireAdmin);

admin.get('/refunds', async (req, res, next) => {
  try {
    res.json({ items: (await listRefundRequests()).map(toApi) });
  } catch (err) {
    next(err);
  }
});

const ADMIN_ERRORS = {
  not_found: [404, 'orden no encontrada'],
  conflict: [409, 'la orden no está en un estado que permita esto'],
  already_paid_out: [409, 'la orden ya se liquidó al comercio'],
  nothing_to_pay: [409, 'no hay órdenes pendientes por liquidar para ese comercio'],
};

admin.post('/orders/:id/refund-request', validId, async (req, res, next) => {
  try {
    const result = await adminRequestRefund(req.params.id, correlation(req));
    if (result.outcome !== 'refund_requested') return sendOutcome(res, ADMIN_ERRORS, result);
    res.json(toApi(result.order));
  } catch (err) {
    next(err);
  }
});

const refundSchema = z.object({ reference: z.string().trim().max(200).optional() }).strict();
admin.post('/orders/:id/refund', validId, async (req, res, next) => {
  const parsed = refundSchema.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed.error);
  try {
    const result = await markRefunded(req.params.id, req.auth.userId, parsed.data.reference, correlation(req));
    if (result.outcome !== 'refunded') return sendOutcome(res, ADMIN_ERRORS, result);
    res.json(toApi(result.order));
  } catch (err) {
    next(err);
  }
});

admin.get('/payouts/pending', async (req, res, next) => {
  try {
    res.json({ items: await pendingPayouts() });
  } catch (err) {
    next(err);
  }
});

const payoutSchema = z
  .object({ merchantId: z.uuid(), reference: z.string().trim().max(200).optional(), paidAt: z.iso.datetime().optional() })
  .strict();
admin.post('/payouts', async (req, res, next) => {
  const parsed = payoutSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  try {
    const result = await recordPayout(parsed.data.merchantId, req.auth.userId, parsed.data, correlation(req));
    if (result.outcome !== 'recorded') return sendOutcome(res, ADMIN_ERRORS, result);
    res.status(201).json(result.payout);
  } catch (err) {
    next(err);
  }
});

paymentsRouter.use('/admin', admin);
