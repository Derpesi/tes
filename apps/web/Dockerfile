# Image web HRIS (Next.js). Bangun dari AKAR repo:
#   docker build -f apps/web/Dockerfile --build-arg API_URL=http://api:3001 -t hris-web:<tag> .
# API_URL ditanam saat build (rewrite /api/* -> API, same-origin). Ganti API_URL = bangun ulang image.
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY tests/package.json tests/
RUN pnpm install --frozen-lockfile --filter @hris/web...
COPY apps/web apps/web
ARG API_URL=http://api:3001
# Izin kamera /absen hanya dibuka bila on (samakan dengan ABSENSI_SELFIE di API; ditanam saat build).
ARG ABSENSI_SELFIE=off
ENV API_URL=$API_URL ABSENSI_SELFIE=$ABSENSI_SELFIE NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @hris/web build \
 && pnpm --filter @hris/web deploy --prod --legacy /out \
 && cp -r apps/web/.next /out/.next \
 && cp apps/web/next.config.mjs /out/next.config.mjs

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
