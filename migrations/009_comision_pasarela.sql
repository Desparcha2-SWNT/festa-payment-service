-- Decisión del equipo (2026-11-21): la comisión de Wompi de las boletas la paga el comercio.
-- El comprador paga el precio de la boleta (total = subtotal); lo que se liquida al comercio es
-- subtotal - gateway_fee_cents. Se guarda por orden para que un cambio de tarifa no reescriba el pasado.
ALTER TABLE orders ADD COLUMN gateway_fee_cents integer NOT NULL DEFAULT 0 CHECK (gateway_fee_cents >= 0);
