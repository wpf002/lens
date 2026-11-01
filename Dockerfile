# Lens hosted server (Railway). Mount a volume at /data.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

ENV NODE_ENV=production \
    LENS_WORKSPACE=/data \
    PORT=8080
EXPOSE 8080
CMD ["node", "packages/cli/dist/index.js", "cloud"]
