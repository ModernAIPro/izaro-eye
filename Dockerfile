FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile && pnpm --filter @izaro/web build
ENV PORT=4000 DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 4000
CMD ["pnpm", "--filter", "@izaro/server", "start"]
