FROM mcr.microsoft.com/playwright:v1.40.0-jammy

# Create app directory
WORKDIR /app

# Copy package configuration files
COPY package.json ./

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

CMD ["npm", "start"]
