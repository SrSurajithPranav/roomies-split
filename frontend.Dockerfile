FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY lib ./lib
COPY artifacts/roomies-split ./artifacts/roomies-split

ENV NODE_ENV=production
ENV PORT=4173
ENV BASE_PATH=/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/roomies-split run build

FROM nginx:1.29-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/artifacts/roomies-split/dist/public /usr/share/nginx/html

EXPOSE 80
