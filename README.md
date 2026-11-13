# festa-payment-service

RF11 y RN2: venta de boletas dentro de la app con [Wompi](https://docs.wompi.co) y comisión de Festa por boleta.
Node 20 / Express con PostgreSQL (`payment_db`). Puerto 8085.

La app **nunca** envía datos de tarjeta a Festa (RNF6): este servicio crea la orden, firma el monto y la app abre el
checkout de Wompi. Wompi avisa el resultado por webhook firmado.

## Flujo (festa-infra/contracts/README.md § Compra de boletas)

1. `event.published` / `event.updated` alimentan una proyección local con precio y cupo (no hay llamadas síncronas a event-service).
2. `POST /payments/orders` crea la orden `PENDING`, **retiene los cupos** `RESERVATION_HOLD_MINUTES` (15) y publica `order.created`.
   Devuelve `checkout` con la referencia, la firma de integridad y `checkoutUrl` (Web Checkout de Wompi).
3. Wompi llama `POST /webhooks/wompi`. Se verifica la firma (`WOMPI_EVENTS_SECRET`), que el monto coincida y se publica
   `order.approved` o `order.failed`. Los webhooks repetidos se ignoran.
4. Un job cada 30 s vence las órdenes sin pago (`order.expired`) y libera los cupos. Un pago aprobado que llega tarde se
   vende si aún hay cupo; si no, pasa a reembolso.
5. booking-service consume `order.approved` y emite un pase QR por boleta.

**Comisión (RN2):** la paga el comprador encima del precio: `total = subtotal + comisión`, con
`comisión = round(precio × COMMISSION_PERCENT / 100) + COMMISSION_FIXED_CENTS` por boleta. Al arrancar se avisa si la
comisión no cubre el costo de Wompi (2,99 % + IVA). El comercio recibe el subtotal en las liquidaciones.

## API

Todas con JWT salvo el webhook. El cliente las llama con el prefijo `/api` (Kong lo quita).

| Método y ruta | Qué hace |
|---|---|
| `GET /payments/events/{id}/quote?quantity=2` | Precio, comisión, total y cupos libres |
| `POST /payments/orders` `{eventId, quantity}` | Crea la orden y devuelve el checkout. Acepta `Idempotency-Key` |
| `GET /payments/orders/mine` | Órdenes del usuario |
| `GET /payments/orders/{id}` | Una orden (comprador o admin) |
| `GET /payments/merchants/me/summary` | Comercio: boletas vendidas, bruto y pendiente por liquidar por evento |
| `POST /payments/orders/{id}/simulate` `{status}` | **Solo desarrollo** (`PAYMENTS_ALLOW_SIMULATION=true`): simula la respuesta de Wompi |
| `GET /payments/admin/refunds` | Admin: órdenes con reembolso pendiente |
| `POST /payments/admin/orders/{id}/refund-request` | Admin: pide el reembolso de una orden aprobada |
| `POST /payments/admin/orders/{id}/refund` `{reference?}` | Admin: registra que el reembolso se hizo (`order.refunded`) |
| `GET /payments/admin/payouts/pending` | Admin: lo que se le debe a cada comercio (eventos terminados) |
| `POST /payments/admin/payouts` `{merchantId, reference?, paidAt?}` | Admin: registra una liquidación (`payout.recorded`) |
| `POST /webhooks/wompi` | Webhook de Wompi (público, firma verificada) |
| `GET /health`, `GET /metrics` | Estado y métricas de Prometheus |

## Mensajería

- **Publica** en `festa.payment`: `order.created`, `order.approved`, `order.failed`, `order.expired`,
  `order.refund_requested`, `order.refunded`, `payout.recorded` (outbox transaccional).
- **Consume** de `payment-service.inbox`: `event.published`, `event.updated`, `event.cancelled` (vence pendientes y pide
  reembolso de las aprobadas), `event.expired`, `merchant.verified`, `merchant.updated`, `account.deleted` (anonimiza
  al comprador; las órdenes se conservan por contabilidad).

## Correr en local

```bash
cp .env.example .env   # y ajusta los valores
npm ci
npm test
npm start
```

Con el resto del stack: `docker compose --profile payment up -d --build` desde `festa-infra`. Para que Wompi alcance el
webhook en local está el perfil `tunnel` (cloudflared) de festa-infra; configura la URL pública + `/webhooks/wompi` en el
panel de Wompi (sandbox).
