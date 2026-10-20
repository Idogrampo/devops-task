# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# npm/yarn are not needed at runtime; dropping them also drops their bundled dependencies from the scan
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn-*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json app.js ./
# Numeric UID so Kubernetes can verify runAsNonRoot
USER 1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/live || exit 1
CMD ["node", "app.js"]
