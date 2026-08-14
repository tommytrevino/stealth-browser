FROM mcr.microsoft.com/playwright:v1.45.0-jammy

# Create app directory
WORKDIR /app

# Install build dependencies for native Node C++ bindings and Xvfb
RUN apt-get update && \
    apt-get install -y python3 build-essential xvfb && \
    rm -rf /var/lib/apt/lists/*

# Copy package configuration files
COPY package.json package-lock.json* ./

# Install npm dependencies
RUN npm install

# Download the custom stealth browser engine
RUN npx camoufox-js fetch

# Copy the rest of the application files
COPY . .

# Build typescript into JavaScript dist/
RUN npm run build

# Start Express server
EXPOSE 9377
ENV PORT=9377

CMD ["xvfb-run", "-a", "--server-args=-screen 0 1280x800x24", "node", "dist/server.js"]
