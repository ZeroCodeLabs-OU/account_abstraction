# Use the official Node.js image
FROM node:20.12.2

# Set the working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install app dependencies
RUN npm install

# Bundle app source
COPY . .

# Expose port 3000
EXPOSE 8000

# Start the app
CMD ["node", "app.js"]
