# Use Node.js 22 on Alpine (small image)
FROM node:22-alpine

# Set working directory inside the container
WORKDIR /app

# Copy package files first (Docker caches this layer)
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy prisma schema and generate client
COPY prisma ./prisma
RUN npx prisma generate

# Copy the rest of the source code
COPY src ./src

# Expose the backend port
EXPOSE 5001

# Start the server
CMD ["node", "src/index.js"]
