# Conduit endpoint — deterministic build for Railway (no builder guessing).
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Railway injects $PORT; the app binds to it (config.port = env.PORT).
CMD ["npm", "start"]
