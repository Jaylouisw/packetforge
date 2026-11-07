# syntax=docker/dockerfile:1

# PacketForge — zero-dependency app, so there is no build/install stage.
FROM node:20-alpine

WORKDIR /app

# Copy sources (see .dockerignore for what's excluded).
COPY . .

ENV NODE_ENV=production \
    PORT=8000

EXPOSE 8000

# Run as the unprivileged `node` user (the app only reads its sources).
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8000/api/catalog >/dev/null 2>&1 || exit 1

CMD ["node", "server/index.js"]
