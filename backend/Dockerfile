# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=20-alpine

# ---- deps: instala todo (incluye dev) para poder compilar ----
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: genera cliente Prisma y compila TS ----
FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate
RUN npm run build

# ---- runtime: imagen final mas liviana, solo prod deps ----
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Copia cliente Prisma ya generado + schema para migraciones en runtime si hace falta.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/dist ./dist
EXPOSE 3000
# CMD por defecto apunta al API. Los workers sobreescriben con `command:` en compose.
CMD ["node", "dist/index.js"]
