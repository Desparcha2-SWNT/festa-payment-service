import { logger } from '../logger.js';
import { expireDueOrders } from '../orders/repository.js';

/**
 * Vence las órdenes PENDING cuya retención (RESERVATION_HOLD_MINUTES) pasó y libera sus cupos.
 * `FOR UPDATE SKIP LOCKED` en expireDueOrders permite varias réplicas sin vencer dos veces.
 */
export function startExpiryJob({ intervalMs = 30_000 } = {}) {
  let stopped = false;
  let timer;

  const tick = async () => {
    if (stopped) return;
    try {
      const count = await expireDueOrders();
      if (count > 0) logger.info({ count }, 'órdenes vencidas');
    } catch (err) {
      logger.error(err, 'fallo venciendo órdenes, se reintenta en el siguiente tick');
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };

  timer = setTimeout(tick, intervalMs);
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
