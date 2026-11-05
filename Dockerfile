FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
COPY scripts/build-vendor.mjs scripts/build-vendor.mjs
COPY vendor/ vendor/
RUN npm ci --omit=dev && npx playwright install --with-deps chromium
COPY . .
ENV FGK_DATA_DIR=/app/data
VOLUME ["/app/data"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/cli.mjs", "worker"]
