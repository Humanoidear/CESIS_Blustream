# Use the latest Node.js LTS image with Debian slim for smaller footprint
FROM node:22-slim AS deps
WORKDIR /app

# Install only production dependencies using package-lock for reproducibility
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy installed dependencies from the deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy the rest of the application source code
COPY . .

# Ensure the JSON output directory exists at runtime
RUN mkdir -p /app/json

# Run the process as the non-root node user for better security
USER node

EXPOSE 3000
CMD ["npm", "start"]
