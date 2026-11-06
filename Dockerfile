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
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Railway mounts the volume owned by root. Hand it to the node user, then run the app as node.
ENTRYPOINT ["/bin/sh", "-c", "mkdir -p \"$LENS_WORKSPACE\" && find \"$LENS_WORKSPACE\" ! -user node -exec chown -h node:node {} + && exec setpriv --reuid=node --regid=node --init-groups env HOME=/home/node \"$@\"", "lens"]
CMD ["node", "packages/cli/dist/index.js", "cloud"]
