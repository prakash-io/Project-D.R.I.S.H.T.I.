FROM node:20-alpine

WORKDIR /app

# Copy package files first for better Docker layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application source
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY run_migrations.mjs ./

EXPOSE 8000

# Koyeb provides PORT as env var; the app reads process.env.PORT
CMD ["node", "src/server.js"]
