FROM node:22-bookworm-slim AS builder
WORKDIR /build

COPY package*.json ./
RUN npm ci

COPY nest-cli.json tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

# Bake the English OCR language data into the image at build time (from the npm registry,
# the same trust boundary as the rest of the dependency tree) so image-to-text extraction
# in the knowledge base works fully offline — no CDN call at request time.
RUN npm install --no-save @tesseract.js-data/eng@1.0.0 \
    && mkdir -p /app/tessdata \
    && cp node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz /app/tessdata/eng.traineddata.gz \
    && rm -rf node_modules/@tesseract.js-data

ENV PLAYWRIGHT_BROWSERS_PATH=/app/pw-browsers
RUN npx playwright install --with-deps chromium firefox webkit

ARG K6_VERSION=v0.55.0
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates tar \
    && ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://github.com/grafana/k6/releases/download/${K6_VERSION}/k6-${K6_VERSION}-linux-${ARCH}.tar.gz" \
    | tar -xz --strip-components=1 -C /usr/local/bin "k6-${K6_VERSION}-linux-${ARCH}/k6" \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/dist ./dist
COPY migrations ./migrations

RUN mkdir -p /app/uploads && groupadd -r app && useradd -r -g app app && chown -R app:app /app
USER app

EXPOSE 7000
CMD ["node", "dist/main.js"]
