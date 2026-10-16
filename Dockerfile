# Tiny Warfare game server: static client, WebSocket rooms (/ws) and the
# leaderboard API in one Node process. See docs/deployment.md.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8020 \
    TINY_STRIKE_DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.mjs index.html LICENSE ASSETS.md ./
COPY src ./src
COPY assets ./assets
# tools/ holds the ?trailer camera; the qa/ viewers are for development only.
COPY tools ./tools
# The leaderboard file lives here; mount a volume to keep it across deploys.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 8020
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null || exit 1
CMD ["node", "server.mjs"]
