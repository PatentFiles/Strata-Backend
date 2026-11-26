FROM node:24.22.3-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY book.mjs capture.mjs ws-adapter.mjs tls-dial.mjs runtime.mjs ./
USER node
CMD ["node", "runtime.mjs"]
