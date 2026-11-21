-- Cobros de Wompi que no coinciden con la orden (monto o moneda). El webhook responde 200 para que Wompi
-- deje de reintentar, así que este registro durable es lo que permite conciliar o reembolsar el cobro.
-- Único por transacción y tipo: un reintento del mismo webhook no duplica el registro.
CREATE TABLE payment_discrepancies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('amount_mismatch', 'currency_mismatch')),
  transaction_id  text NOT NULL,
  amount_cents    integer,
  currency        text,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  UNIQUE (transaction_id, kind)
);
CREATE INDEX payment_discrepancies_open_idx ON payment_discrepancies (detected_at) WHERE resolved_at IS NULL;
