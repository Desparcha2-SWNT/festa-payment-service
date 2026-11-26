// Los logs de petición no deben dejar en claro el bearer token ni las cookies.
import { Writable } from 'node:stream';
import express from 'express';
import pinoHttp from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';

describe('logger', () => {
  it('redacta Authorization y Cookie en el log de cada petición', async () => {
    const lines = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const app = express();
    app.use(pinoHttp({ logger: createLogger(sink, 'info') }));
    app.get('/ping', (req, res) => res.json({ ok: true }));

    await request(app).get('/ping').set('Authorization', 'Bearer token-secreto-123').set('Cookie', 'sid=cookie-secreta-456');

    const log = lines.join('');
    expect(log).toContain('/ping'); // sí se registró la petición
    expect(log).not.toContain('token-secreto-123');
    expect(log).not.toContain('cookie-secreta-456');
    expect(log).toContain('[REDACTED]');
  });
});
