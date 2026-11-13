import { Router } from 'express';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';
import { applyTransaction } from '../orders/repository.js';
import { verifyEventSignature } from './wompi.js';

export const webhookRouter = Router();

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
  try {
    const seen = await pool.query(
      'INSERT INTO wompi_webhooks (checksum, reference, status) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [body.signature.checksum, String(tx.reference ?? ''), String(tx.status ?? '')],
    );
    if (seen.rowCount === 0) return res.json({ duplicate: true });

    const result = await applyTransaction(
      {
        reference: tx.reference,
        status: tx.status,
        amountInCents: tx.amount_in_cents,
        transactionId: tx.id,
        paymentMethodType: tx.payment_method_type,
        statusMessage: tx.status_message,
      },
      req.headers['x-correlation-id'] ?? null,
    );
    if (result.outcome === 'amount_mismatch') {
      logger.error({ reference: tx.reference, amount: tx.amount_in_cents }, 'el monto de Wompi no coincide con la orden');
    }
    res.json({ outcome: result.outcome });
  } catch (err) {
    // Se borra la marca para que el reintento de Wompi sí se procese.
    await pool.query('DELETE FROM wompi_webhooks WHERE checksum = $1', [body.signature.checksum]).catch(() => {});
    next(err);
  }
});
