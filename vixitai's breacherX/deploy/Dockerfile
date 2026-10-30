# BreacherX control-plane image.
# Build context is the project directory (the one containing package.json):
#   docker build -f deploy/Dockerfile -t breacherx:latest .
#
# Multi-stage: compile with the full toolchain, run with production deps only.
# BreacherX has no runtime npm dependencies, so the runtime image is tiny.

# ---- build stage ------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY bench ./bench
COPY test ./test
RUN npm run build

# ---- runtime stage ----------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# External deterministic analyzers (optional but recommended). Ruff is a single
# static binary; eslint/semgrep can be added per project needs.
# Uncomment to bundle ruff:
# RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
#   && curl -LsSf https://astral.sh/ruff/install.sh | sh \
#   && apt-get purge -y curl && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist ./dist
COPY package.json ./
COPY bench/datasets ./bench/datasets
COPY src/db/schema.sql ./src/db/schema.sql

# Run as non-root.
USER node

ENV PORT=8787
EXPOSE 8787

# Healthcheck hits the control plane's liveness endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/server/index.js"]
