FROM node:22-alpine

# Legacy Docker builder has a DNS/network bug where RUN steps can't reach
# external hosts reliably even though `docker run` works. Workaround:
# build with `docker build --network=host` (passed from docker-compose.yml).
RUN apk add --no-cache openssl ca-certificates

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma

RUN npm config set fetch-timeout 600000 \
 && npm ci --omit=dev --no-audit --no-fund --ignore-scripts

RUN npx prisma generate

COPY . .

EXPOSE 5001

CMD ["node", "src/index.js"]
