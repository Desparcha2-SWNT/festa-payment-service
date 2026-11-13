// Variables de entorno y una llave JWT desechable para que los módulos que las leen al
// importarse (config.js, middleware/auth.js) no truenen al cargar las pruebas. La misma
// llave (test/fixtures/jwtKeys.js) la usan las pruebas que necesitan firmar un token.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { jwtPublicKeyPem } from './fixtures/jwtKeys.js';

const dir = mkdtempSync(path.join(tmpdir(), 'festa-payment-service-test-'));
const publicKeyPath = path.join(dir, 'jwt_public.pem');
writeFileSync(publicKeyPath, jwtPublicKeyPem);

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/payment_db_test';
process.env.AMQP_URL ??= 'amqp://test:test@localhost:5672';
process.env.JWT_ISSUER ??= 'festa-auth';
process.env.JWT_PUBLIC_KEY_PATH = publicKeyPath;
process.env.LOG_LEVEL ??= 'silent';
