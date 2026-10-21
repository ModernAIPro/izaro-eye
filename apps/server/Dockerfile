# Server only, for the Vercel `server` service (see vercel.json). The web UI is
# its own service there, so it is not built here. The root Dockerfile still
# builds both for a single self-hosted container.
# Built from the repository root so the workspace packages and lockfile are in
# the build context.
FROM node:26-bookworm-slim
WORKDIR /app
RUN npm i -g pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/web/package.json ./apps/web/package.json
COPY apps/server ./apps/server
RUN pnpm install --frozen-lockfile --filter @izaro/server... \
  && pnpm --filter @izaro/server exec playwright install --with-deps chromium
ENV PORT=4000 DATA_DIR=/data NODE_ENV=production
EXPOSE 4000
CMD ["pnpm", "--filter", "@izaro/server", "start"]
