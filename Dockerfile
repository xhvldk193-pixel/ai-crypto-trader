FROM node:22-alpine
RUN npm install -g pnpm
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/db run build 2>/dev/null || true
RUN pnpm --filter @workspace/api-zod run build 2>/dev/null || true
RUN pnpm --filter @workspace/integrations-anthropic-ai run build 2>/dev/null || true
RUN pnpm --filter @workspace/integrations-openai-ai-server run build 2>/dev/null || true
RUN pnpm --filter @workspace/api-client-react run build 2>/dev/null || true
RUN PORT=3000 BASE_PATH=/ pnpm --filter @workspace/crypto-trader run build
RUN mkdir -p artifacts/api-server/public && cp -r artifacts/crypto-trader/dist/public/* artifacts/api-server/public/
RUN pnpm --filter @workspace/api-server run build
EXPOSE 8080
CMD ["pnpm", "--filter", "@workspace/api-server", "run", "start"]
