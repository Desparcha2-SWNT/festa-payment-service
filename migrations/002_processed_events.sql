-- Idempotencia de mensajes consumidos (ver festa-infra/contracts/README.md § Consumir).
-- El eventId procesado se guarda en la misma transacción que su efecto; un duplicado se
-- detecta aquí y se confirma (ack) sin repetir el efecto.

CREATE TABLE processed_events (
  event_id     uuid PRIMARY KEY,
  event_type   text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
