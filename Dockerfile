FROM mcr.microsoft.com/playwright:v1.53.1-jammy

# Create app directory
WORKDIR /app

# Install build dependencies for native Node C++ bindings, Xvfb, Mesa GLX, and tini
RUN apt-get update && \
    apt-get install -y python3 build-essential xvfb libgl1-mesa-glx libgl1-mesa-dri tini && \
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
ENV MOZ_DISABLE_CONTENT_SANDBOX=1
ENV DISABLE_WAYLAND=1

RUN chmod +x start.sh
# tini runs as PID 1 and reaps orphaned processes. Without it node was PID 1 and never reaped the Firefox helpers each
# browser leaves behind (4 zombies per launch); they filled the container's 1000-process limit and every browser
# launch crashed from 2026-11-04.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./start.sh"]
