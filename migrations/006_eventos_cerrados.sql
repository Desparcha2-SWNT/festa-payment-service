-- Lápida de eventos cerrados (cancelados o expirados). Los mensajes llegan desordenados: si event.cancelled
-- llega antes que el snapshot event.published, un snapshot retrasado no debe volver a abrir la venta.
-- event.cancelled y event.expired no llevan versión comparable en este servicio, así que esta tabla manda.
CREATE TABLE closed_events (
  event_id  uuid PRIMARY KEY,
  status    text NOT NULL CHECK (status IN ('cancelled', 'expired')),
  closed_at timestamptz NOT NULL DEFAULT now()
);
