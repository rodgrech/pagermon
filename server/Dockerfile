FROM node:20-bookworm-slim

ENV APP_NAME=PagerMon \
    NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl gosu python3 make g++ sqlite3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional \
    && npm cache clean --force

COPY . /app

RUN mkdir -p /config /defaults \
    && cp /app/config/default.json /defaults/config.json \
    && sed -i 's#"\./messages\.db[^\"]*"#"/config/messages.db"#' /defaults/config.json \
    && rm -f /app/config/config.json /app/config/backup.json \
    && ln -s /config/config.json /app/config/config.json \
    && ln -s /config/backup.json /app/config/backup.json \
    && chown -R node:node /app /defaults /config

COPY docker-entrypoint.sh /usr/local/bin/pagermon-entrypoint
RUN chmod 0755 /usr/local/bin/pagermon-entrypoint

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:3000/ >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/pagermon-entrypoint"]
CMD ["node", "app.js"]
