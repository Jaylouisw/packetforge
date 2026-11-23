# syntax=docker/dockerfile:1

# PacketForge — zero-dependency app, so there is no build/install stage.
# The runtime the package declares: `engines.node` is `>=22.18.0` in package.json, and
# 22.18 is where Node strips the type annotations off a `.ts` file with no flag and no
# build step (docs/TYPESCRIPT.md). An image on 20 would be the one host in this
# repository that cannot run the language the repository writes.
FROM node:22-alpine

WORKDIR /app

# Copy sources (see .dockerignore for what's excluded).
COPY . .

# The image is published on a port, so the process has to be reachable from the host: `docker run -p
# 8000:8000` cannot work against a socket bound to the container's own loopback. A bare
# `node server/index.js` outside the image listens on 127.0.0.1 only (#1527).
ENV NODE_ENV=production \
    PORT=8000 \
    PF_HOST=0.0.0.0

EXPOSE 8000

# Run as the unprivileged `node` user (the app only reads its sources).
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8000/api/catalog >/dev/null 2>&1 || exit 1

CMD ["node", "server/index.js"]
