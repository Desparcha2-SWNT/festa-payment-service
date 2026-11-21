-- Distingue un webhook de Wompi ya aplicado (processed_at) de uno en curso o fallido.
-- Antes, la sola existencia de la fila marcaba "procesado": un duplicado recibía 200 aunque el
-- primer procesamiento hubiera fallado, y Wompi dejaba de reintentar.
ALTER TABLE wompi_webhooks ADD COLUMN processed_at timestamptz;
-- Identidad del intento que tiene la marca: solo ese intento puede finalizarla o borrarla.
ALTER TABLE wompi_webhooks ADD COLUMN claim_id uuid;

-- Las filas que ya existen se aplicaron con el código anterior: se marcan como procesadas para que
-- no se vuelvan a aplicar tras el despliegue.
UPDATE wompi_webhooks SET processed_at = received_at WHERE processed_at IS NULL;
