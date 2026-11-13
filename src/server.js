import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { startMessaging } from './messaging/supervisor.js';
import { startExpiryJob } from './jobs/expireOrders.js';
import { commissionCoversWompi } from './orders/pricing.js';

async function main() {
  // RN2: con la configuración actual la comisión debe cubrir lo que cobra Wompi.
  if (!commissionCoversWompi(1_000_000)) {
    logger.warn(config.fees, 'COMMISSION_PERCENT no cubre el costo de Wompi + IVA: Festa pierde dinero por boleta');
  }
  if (!config.wompi.eventsSecret || !config.wompi.integritySecret) {
    logger.warn('faltan WOMPI_EVENTS_SECRET o WOMPI_INTEGRITY_SECRET: el checkout y el webhook no funcionarán');
  }

  await migrate();
  const messaging = await startMessaging();
  const expiry = startExpiryJob();

  const server = createApp().listen(config.port, () => {
    logger.info({ port: config.port }, 'festa-payment-service arriba');
  });

  const shutdown = async () => {
    logger.info('apagando...');
    server.close();
    expiry.stop();
    await messaging.stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error(err, 'no se pudo arrancar el servicio');
  process.exit(1);
});
