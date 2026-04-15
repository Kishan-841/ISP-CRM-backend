FROM node:22-alpine

RUN apk add --no-cache openssl ca-certificates

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma

# Step 1: install deps but SKIP postinstall (which runs prisma generate).
# Keeping install and generate separate lets us see which step hangs + cache better.
RUN npm config set fetch-timeout 600000 \
 && npm ci --omit=dev --no-audit --no-fund --ignore-scripts

# Step 2: explicitly run prisma generate so failures are visible at this layer.
# PRISMA_CLI_BINARY_TARGETS fixes a known slow-binary-download issue on alpine.
RUN npx prisma generate

COPY . .

EXPOSE 5001

CMD ["node", "src/index.js"]
