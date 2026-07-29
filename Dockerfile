FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
ARG BASE_PATH=/
ENV BASE_PATH=${BASE_PATH}
COPY . .
RUN npm run build

# Runtime is glibc (Debian) so the bundled Spotty helper (a glibc x86_64 binary)
# can run for background track archival. ffmpeg encodes the fetched PCM to FLAC;
# ca-certificates is needed for Spotify's HTTPS.
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server
EXPOSE 4177
CMD ["node", "server/index.js"]
