-- Un segundo cobro APROBADO de la misma referencia (otra transacción de Wompi) es una discrepancia más para conciliar:
-- antes el webhook lo daba por visto sin dejar rastro.
ALTER TABLE payment_discrepancies DROP CONSTRAINT payment_discrepancies_kind_check;
ALTER TABLE payment_discrepancies
  ADD CONSTRAINT payment_discrepancies_kind_check CHECK (kind IN ('amount_mismatch', 'currency_mismatch', 'duplicate_charge'));
