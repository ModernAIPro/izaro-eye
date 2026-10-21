FROM node:26-bookworm-slim
WORKDIR /app
RUN npm i -g pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @izaro/server exec playwright install --with-deps chromium \
  && pnpm --filter @izaro/web build
ENV PORT=4000 DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 4000
CMD ["pnpm", "--filter", "@izaro/server", "start"]
