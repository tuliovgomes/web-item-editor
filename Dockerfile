FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY eslint.config.cjs ./
COPY src ./src
COPY tests ./tests
COPY docs ./docs
COPY web ./web
RUN npm run build

CMD ["npm", "test"]
