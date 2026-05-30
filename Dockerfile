FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
ARG BASE_PATH=/
ENV BASE_PATH=${BASE_PATH}
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
RUN apk add --no-cache ffmpeg
COPY --from=build /app/dist ./dist
COPY server ./server
EXPOSE 4177
CMD ["node", "server/index.js"]
