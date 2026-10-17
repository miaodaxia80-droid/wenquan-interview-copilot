FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server ./server
COPY web/core.js web/interview.js web/intelligence.js web/audio-file.js web/platform.js ./web/
USER node
EXPOSE 8787
CMD ["node", "server/service.mjs"]
