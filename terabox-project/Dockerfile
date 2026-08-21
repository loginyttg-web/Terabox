# TeraBox Pro Bot — Railway Dockerfile (Node 22)
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Required for zip split
RUN apk add --no-cache zip
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder /app/dist ./dist

# Create temp dirs for transfers & access
RUN mkdir -p /tmp/terabox-transfers && chmod 700 /tmp/terabox-transfers

EXPOSE 8080
ENV HOST=0.0.0.0
ENV PORT=8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-8080}/health || exit 1

CMD ["node", "dist/index.js"]
