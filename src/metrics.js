import client from 'prom-client';

// Prometheus (festa-infra/prometheus/prometheus.yml) scrapea /metrics de cada servicio.
export const registry = new client.Registry();
registry.setDefaultLabels({ service: 'payment-service' });
client.collectDefaultMetrics({ register: registry });

export const httpRequests = new client.Counter({
  name: 'http_requests_total',
  help: 'Peticiones HTTP por método, ruta y código',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

/** Middleware que cuenta cada respuesta por ruta (la plantilla, no el path con ids). */
export function countRequests(req, res, next) {
  res.on('finish', () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    httpRequests.inc({ method: req.method, route, status: res.statusCode });
  });
  next();
}
