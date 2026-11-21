# syntax=docker/dockerfile:1.7
# Build:  docker build --build-context contracts=../festa-infra/contracts -t festa-payment-service .
# (docker compose en festa-infra ya pasa el contexto "contracts").

FROM node:20-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
COPY --from=contracts . /contracts
# Las pruebas (incluida la de contrato) corren en el build: si fallan, no hay imagen.
RUN FESTA_CONTRACTS_DIR=/contracts npm test
RUN npm prune --omit=dev

FROM node:20-alpine
RUN addgroup -S festa && adduser -S festa -G festa
WORKDIR /app
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/package.json ./
COPY --from=build /build/src ./src
COPY --from=build /build/migrations ./migrations
# El inbox (payment-service) valida mensajes contra estos esquemas en runtime.
COPY --from=build /contracts ./contracts
ENV FESTA_CONTRACTS_DIR=/app/contracts
USER festa
EXPOSE 8085
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -qO- http://localhost:8085/health > /dev/null || exit 1
ENTRYPOINT ["node", "src/server.js"]
