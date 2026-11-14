import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';
import { applyTransaction } from '../orders/repository.js';
import { verifyEventSignature } from './wompi.js';

export const webhookRouter = Router();

// La ruta es pública y verificar la firma cuesta CPU: se limita por IP. El tope es holgado porque
// Wompi reintenta y agrupa notificaciones; un exceso responde 429 y Wompi vuelve a intentar.
webhookRouter.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));

/**
 * Webhook de Wompi (público en Kong, sin JWT): la autenticidad la da la firma del evento.
 * Wompi reintenta hasta recibir un 200, así que todo lo que no sea un error transitorio responde
 * 200 (incluida una referencia desconocida) para no generar reintentos inútiles.
 */
webhookRouter.post('/wompi', async (req, res, next) => {
  const body = req.body;
  if (!verifyEventSignature(body)) {
    logger.warn('webhook de Wompi con firma inválida');
    return res.status(401).json({ error: 'firma inválida' });
  }
  if (body.event !== 'transaction.updated') return res.json({ ignored: body.event });

  const tx = body.data?.transaction ?? {};
  const checksum = body.signature.checksum;
  try {
    // Marca de la entrega: sin processed_at aún se está procesando (o falló y se va a reintentar).
    const claim = await pool.query(
      'INSERT INTO wompi_webhooks (checksum, reference, status) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [checksum, String(tx.reference ?? ''), String(tx.status ?? '')],
    );
    if (claim.rowCount === 0) {
      const { rows } = await pool.query('SELECT processed_at FROM wompi_webhooks WHERE checksum = $1', [checksum]);
      // Solo un webhook ya aplicado responde 200: Wompi deja de reintentar al recibirlo.
      if (rows[0]?.processed_at) return res.json({ duplicate: true });
      // Otra entrega lo está procesando, o un intento anterior murió sin terminar: se toma solo si
      // la marca está vencida (5 min). Si no, 503 para que Wompi lo reintente más tarde.
      const retake = await pool.query(
        `UPDATE wompi_webhooks SET received_at = now()
          WHERE checksum = $1 AND processed_at IS NULL AND received_at < now() - interval '5 minutes'`,
        [checksum],
      );
      if (retake.rowCount === 0) return res.status(503).json({ error: 'webhook en proceso, reintentar' });
    }

    const result = await applyTransaction(
      {
        reference: tx.reference,
        status: tx.status,
        amountInCents: tx.amount_in_cents,
        currency: tx.currency,
        transactionId: tx.id,
        paymentMethodType: tx.payment_method_type,
        statusMessage: tx.status_message,
      },
      req.headers['x-correlation-id'] ?? null,
    );
    if (result.outcome === 'amount_mismatch') {
      logger.error({ reference: tx.reference, amount: tx.amount_in_cents }, 'el monto de Wompi no coincide con la orden');
    }
    if (result.outcome === 'currency_mismatch') {
      logger.error({ reference: tx.reference, currency: tx.currency }, 'la moneda de Wompi no coincide con la orden');
    }
    await pool.query('UPDATE wompi_webhooks SET processed_at = now() WHERE checksum = $1', [checksum]);
    res.json({ outcome: result.outcome });
  } catch (err) {
    // Se borra la marca para que el reintento de Wompi sí se procese (y el error le hace reintentar).
    await pool.query('DELETE FROM wompi_webhooks WHERE checksum = $1 AND processed_at IS NULL', [checksum]).catch(() => {});
    next(err);
  }
});
