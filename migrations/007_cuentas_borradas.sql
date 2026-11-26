-- Lápida de cuentas borradas (Ley 1581). El JWT sigue siendo válido hasta que vence, así que sin esto una
-- cuenta ya borrada podría crear órdenes nuevas con su `sub`. account.deleted inserta aquí al procesarse
-- y createOrder lo consulta dentro de su transacción.
CREATE TABLE deleted_accounts (
  user_id    uuid PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
