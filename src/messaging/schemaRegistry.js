import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Compila el sobre y todos los esquemas de `data` del catálogo de contratos, indexados por
 * routing key (= eventType). No importa de qué dominio venga un mensaje: cualquier eventType
 * conocido tiene su validador, sin que este servicio necesite saber a qué exchange pertenece.
 */
function build(contractsDir) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  const validateEnvelope = ajv.compile(readJson(path.join(contractsDir, 'envelope.schema.json')));

  const dataValidators = new Map();
  const producers = new Map();
  const exchanges = new Map();
  const eventsDir = path.join(contractsDir, 'events');
  for (const domain of fs.readdirSync(eventsDir)) {
    const domainDir = path.join(eventsDir, domain);
    for (const file of fs.readdirSync(domainDir)) {
      const schema = readJson(path.join(domainDir, file));
      dataValidators.set(schema['x-routing-key'], ajv.compile(schema));
      producers.set(schema['x-routing-key'], schema['x-producer']);
      exchanges.set(schema['x-routing-key'], schema['x-exchange']);
    }
  }

  return {
    validateEnvelope,
    /** El validador de ajv para `data` de ese eventType, o undefined si no hay esquema. */
    getDataValidator: (eventType) => dataValidators.get(eventType),
    /**
     * El `x-producer`/`x-exchange` que el catálogo declara dueño de ese eventType. La forma
     * estructural del mensaje no basta como autorización: nada impide que algo con las
     * credenciales compartidas de RabbitMQ (ver festa-infra, un solo usuario para todos los
     * servicios hoy) publique un mensaje bien formado con un `producer` falso, o lo mande por
     * el exchange equivocado. Esto es una capa extra de defensa, no reemplaza separar
     * credenciales/ACL por servicio en festa-infra (pendiente ahí, no aquí).
     */
    getExpectedProducer: (eventType) => producers.get(eventType),
    /** El exchange real (`msg.fields.exchange` de amqplib) por el que debió llegar este eventType. */
    getExpectedExchange: (eventType) => exchanges.get(eventType),
  };
}

let cached;

/** Se compila una sola vez por proceso: hay ~38 esquemas y no cambian en caliente. */
export function getSchemaRegistry(contractsDir) {
  cached ??= build(contractsDir);
  return cached;
}

export function _resetForTests() {
  cached = undefined;
}
