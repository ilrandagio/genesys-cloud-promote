# Immagine unica per API e worker (cambia solo il comando).
# Il worker ha bisogno di Terraform per CX as Code.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/api
COPY apps/api apps/api
RUN npm run build -w apps/api && npm prune --omit=dev -w apps/api

FROM node:22-bookworm-slim
ARG TERRAFORM_VERSION=1.9.8
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
  && curl -fsSL -o /tmp/tf.zip https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip \
  && unzip /tmp/tf.zip -d /usr/local/bin && rm /tmp/tf.zip \
  && apt-get purge -y curl unzip && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    TF_PLUGIN_CACHE_DIR=/var/cache/terraform-plugins
RUN mkdir -p $TF_PLUGIN_CACHE_DIR /tmp/gc-promote && chown -R node:node $TF_PLUGIN_CACHE_DIR /tmp/gc-promote
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/drizzle apps/api/drizzle
COPY --from=build /app/apps/api/package.json apps/api/
USER node
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/server.js"]
