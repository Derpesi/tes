# Image API HRIS (multi-stage, non-root). Bangun dari AKAR repo:
#   docker build -f apps/api/Dockerfile -t hris-api:<tag> .
# Image TIDAK berisi rahasia: semua konfigurasi lewat variabel lingkungan saat dijalankan (lihat .env.production.example).
# Migrasi dijalankan sebagai langkah terpisah: docker run --rm --env-file ... hris-api:<tag> node scripts/migrate.js up
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY tests/package.json tests/
RUN pnpm install --frozen-lockfile --filter @hris/api...
COPY apps/api apps/api
RUN pnpm --filter @hris/api build \
 && pnpm --filter @hris/api deploy --prod --legacy /out \
 && cp -r apps/api/dist /out/dist

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3001 MIGRATIONS_DIR=/app/db/migrations
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/dist ./dist
COPY --chown=node:node apps/api/scripts/migrate.js ./scripts/migrate.js
COPY --chown=node:node db/migrations ./db/migrations
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# SIGTERM ditangani aplikasi (graceful shutdown); jangan bungkus dengan shell.
CMD ["node", "dist/main.js"]
