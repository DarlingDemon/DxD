FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY index.mjs rooms.mjs ./
USER node
CMD ["node", "index.mjs"]
