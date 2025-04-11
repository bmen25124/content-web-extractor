# Use Node.js LTS as the base image
FROM node:20-slim

# Set the working directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript code
RUN npm run build

# Set user to non-root
USER node

# Expose no ports since this is an stdio-based MCP server

# Command to run the application
CMD ["npm", "start"]