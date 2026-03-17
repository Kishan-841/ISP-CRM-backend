# =============================================================
# WHAT IS THIS FILE?
# A Dockerfile is a set of instructions that tells Docker
# how to package your app into an "image" (a portable box).
# Think of it like a recipe — each line is a step.
# =============================================================

# ----- STEP 1: Pick a base image -----
# Every Docker image starts FROM another image.
# "node:22-alpine" means:
#   - node:22  → Node.js version 22 pre-installed
#   - alpine   → A super tiny Linux (only ~5MB vs ~900MB for Ubuntu)
# Why alpine? Smaller image = faster downloads, less disk space, fewer vulnerabilities.
FROM node:22-alpine

# ----- STEP 2: Install system dependencies -----
# Alpine Linux is minimal — it doesn't even include OpenSSL.
# Prisma needs OpenSSL to communicate with PostgreSQL.
# "apk" is Alpine's package manager (like apt on Ubuntu or brew on Mac).
# "--no-cache" means don't save the package index (keeps image small).
RUN apk add --no-cache openssl

# ----- STEP 3: Set the working directory inside the container -----
# This is like doing "mkdir /app && cd /app" inside the container.
# All following commands will run from this folder.
WORKDIR /app

# ----- STEP 3: Copy package files AND Prisma schema -----
# We copy these BEFORE the rest of the code for Docker layer caching.
# If your code changes but these files didn't, Docker will SKIP
# the "npm install" step and use the cached version — much faster rebuilds.
#
# WHY copy Prisma schema here? Your package.json has a "postinstall"
# script that runs "prisma generate" automatically after npm install.
# If the schema isn't there yet, postinstall fails. So we copy it first.
COPY package.json package-lock.json* ./
COPY prisma ./prisma

# ----- STEP 4: Install dependencies -----
# "npm ci" is like "npm install" but:
#   - Uses exact versions from package-lock.json (reproducible builds)
#   - Faster because it skips some checks
#   - Designed for automated environments like Docker
# "--omit=dev" skips devDependencies (nodemon etc.) since we don't
# need them in production.
#
# The postinstall script ("prisma generate") runs automatically here,
# which is why we copied the prisma/ folder in step 3.
RUN npm ci --omit=dev

# ----- STEP 7: Copy the rest of your application code -----
# Now we copy everything else (src/, uploads/, etc.)
# This is the layer that changes most often, so it's last.
COPY . .

# ----- STEP 8: Tell Docker which port the app uses -----
# EXPOSE doesn't actually open the port — it's documentation.
# It tells other developers (and Docker tools) "this container
# listens on port 5001". The actual port mapping happens when
# you run the container.
EXPOSE 5001

# ----- STEP 9: The command to start the app -----
# CMD is what runs when the container starts.
# "node src/index.js" starts your Express server.
# We use "node" directly (not "nodemon") because in production
# you don't need auto-restart on file changes.
CMD ["node", "src/index.js"]
