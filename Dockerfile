FROM node:22-slim

# 1. pnpm 경로 및 환경 변수 설정
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# 2. Corepack 활성화 및 pnpm 준비
RUN corepack enable && corepack prepare pnpm@latest --activate

# 3. 작업 디렉토리 설정
WORKDIR /app

# 4. 전체 파일 복사
COPY . .

# 5. 의존성 설치
RUN pnpm install --frozen-lockfile

# 6. 워크스페이스 빌드 (실패해도 무시하도록 설정)
RUN pnpm --filter @workspace/db run build 2>/dev/null || true
RUN pnpm --filter @workspace/api-zod run build 2>/dev/null || true
RUN pnpm --filter @workspace/integrations-anthropic-ai run build 2>/dev/null || true
RUN pnpm --filter @workspace/integrations-openai-ai-server run build 2>/dev/null || true
RUN pnpm --filter @workspace/api-client-react run build 2>/dev/null || true

# 7. 메인 서비스 빌드 및 정적 파일 복사
# 여기 포트 3000은 빌드 시 참조되는 값입니다.
RUN PORT=3000 BASE_PATH=/ pnpm --filter @workspace/crypto-trader run build
RUN mkdir -p artifacts/api-server/public && cp -r artifacts/crypto-trader/dist/public/* artifacts/api-server/public/
RUN pnpm --filter @workspace/api-server run build

# 8. 포트 개방 (3000으로 변경)
EXPOSE 3000

# 9. 서비스 실행
CMD ["pnpm", "--filter", "@workspace/api-server", "run", "start"]
