-- Boletería (RF11, RN2). payment-service no le pregunta nada a event-service: mantiene su propia
-- copia de precio y cupo, alimentada por event.published / event.updated y demás
-- (ver festa-infra/contracts/README.md § Compra de boletas).

CREATE TABLE event_projection (
  event_id              uuid PRIMARY KEY,
  organizer_id          uuid NOT NULL,
  merchant_id           uuid,
  title                 text NOT NULL,
  starts_at             timestamptz NOT NULL,
  ends_at               timestamptz NOT NULL,
  capacity              integer,
  ticketed              boolean NOT NULL,
  price_cents           integer NOT NULL,
  max_tickets_per_order integer,
  status                text NOT NULL CHECK (status IN ('published', 'hidden', 'cancelled', 'expired')),
  version               integer NOT NULL,
  -- Cupos ya vendidos (órdenes APPROVED) y retenidos (órdenes PENDING vigentes). Los lleva este
  -- servicio en la misma transacción que la orden, con la fila del evento bloqueada.
  sold                  integer NOT NULL DEFAULT 0 CHECK (sold >= 0),
  held                  integer NOT NULL DEFAULT 0 CHECK (held >= 0),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Comercios verificados (merchant.verified / merchant.updated): a quién se le liquida.
CREATE TABLE merchants (
  merchant_id    uuid PRIMARY KEY,
  user_id        uuid NOT NULL,
  business_name  text NOT NULL,
  verified_at    timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX merchants_user_id_idx ON merchants (user_id);

CREATE TABLE orders (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Referencia que viaja a Wompi y vuelve en el webhook. Única.
  reference                text NOT NULL UNIQUE,
  event_id                 uuid NOT NULL REFERENCES event_projection (event_id),
  organizer_id             uuid NOT NULL,
  merchant_id              uuid,
  -- Si el comprador borra su cuenta (Ley 1581) se reemplaza por el uuid nulo
  -- (00000000-...): la orden se conserva anonimizada por contabilidad.
  buyer_id                 uuid NOT NULL,
  -- Header Idempotency-Key del cliente: reintentar el POST no crea otra orden.
  idempotency_key          text,
  quantity                 integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  unit_price_cents         integer NOT NULL CHECK (unit_price_cents > 0),
  subtotal_cents           integer NOT NULL,
  commission_cents         integer NOT NULL,
  total_cents              integer NOT NULL,
  currency                 text NOT NULL DEFAULT 'COP',
  status                   text NOT NULL DEFAULT 'PENDING'
                             CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'VOIDED', 'ERROR', 'EXPIRED',
                                               'REFUND_REQUESTED', 'REFUNDED')),
  payment_method           text,
  provider_transaction_id  text,
  failure_reason           text,
  expires_at               timestamptz NOT NULL,
  approved_at              timestamptz,
  refund_requested_at      timestamptz,
  refunded_at              timestamptz,
  refund_reference         text,
  payout_id                uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (subtotal_cents = unit_price_cents * quantity),
  CHECK (total_cents = subtotal_cents + commission_cents)
);
CREATE UNIQUE INDEX orders_idempotency_idx ON orders (buyer_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX orders_buyer_idx ON orders (buyer_id, created_at DESC);
CREATE INDEX orders_event_idx ON orders (event_id);
CREATE INDEX orders_pending_expiry_idx ON orders (expires_at) WHERE status = 'PENDING';
CREATE INDEX orders_payout_pending_idx ON orders (merchant_id) WHERE status = 'APPROVED' AND payout_id IS NULL;

-- Liquidaciones manuales (transferencias) a comercios.
CREATE TABLE payouts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   uuid NOT NULL,
  organizer_id  uuid NOT NULL,
  amount_cents  integer NOT NULL CHECK (amount_cents >= 0),
  order_count   integer NOT NULL,
  period_from   timestamptz NOT NULL,
  period_to     timestamptz NOT NULL,
  reference     text,
  recorded_by   uuid NOT NULL,
  paid_at       timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Webhooks de Wompi ya procesados (Wompi reintenta; un mismo evento puede llegar varias veces).
CREATE TABLE wompi_webhooks (
  checksum      text PRIMARY KEY,
  reference     text NOT NULL,
  status        text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now()
);
