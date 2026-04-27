FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY scripts ./scripts

# /app/data hosts wizard session files; /app/uploads hosts part photos.
# Both must be writable by the runtime `node` user — /app is root-owned
# from COPY above, so create + chown before dropping privileges.
RUN mkdir -p /app/data/import-sessions /app/uploads && \
    chown -R node:node /app/data /app/uploads

ENV NODE_ENV=production
ENV PORT=3000

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
