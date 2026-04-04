# ---------- deps ----------
FROM node:20-alpine AS deps
WORKDIR /app

# Copy both manifest + lock for reproducible installs
COPY package.json package-lock.json ./

# Make npm resilient to flaky network
RUN npm config set fetch-retries 5 \
 && npm config set fetch-retry-mintimeout 20000 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm ci --no-audit --no-fund

# ---------- build ----------
FROM node:20-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG BACKEND_ORIGIN
ARG NEXT_PUBLIC_ENABLE_AB_TEST
ARG NEXT_PUBLIC_ENABLE_GOOGLE_AUTH
ENV BACKEND_ORIGIN=$BACKEND_ORIGIN
ENV NEXT_PUBLIC_ENABLE_AB_TEST=$NEXT_PUBLIC_ENABLE_AB_TEST
ENV NEXT_PUBLIC_ENABLE_GOOGLE_AUTH=$NEXT_PUBLIC_ENABLE_GOOGLE_AUTH

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- runtime ----------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
