# Lens hosted server (Railway). Mount a volume at /data.
FROM node:22-bookworm-slim

# gitleaks: projects whose pre-commit hook runs a secret scan refuse commits without it.
ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && curl -fsSL -o /tmp/gitleaks.tar.gz "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
 && echo "${GITLEAKS_SHA256}  /tmp/gitleaks.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks \
 && rm /tmp/gitleaks.tar.gz \
 && apt-get purge -y curl && apt-get autoremove -y \
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
