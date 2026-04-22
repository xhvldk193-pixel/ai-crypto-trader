FROM node:20-slim
RUN npm install -g pnpm
WORKDIR /app
COPY . .
RUN pnpm install --no-frozen-lockfile
RUN pnpm build
CMD ["pnpm", "start"]
