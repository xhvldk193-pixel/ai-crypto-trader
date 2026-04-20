FROM node:22-slim

# 1. pnpm이 설치될 경로 설정 및 환경 변수 등록
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# 2. Corepack 활성화 및 pnpm 준비
# slim 이미지에서는 설정을 명확히 하기 위해 설치 위치를 지정해주는 것이 좋습니다.
RUN corepack enable && corepack prepare pnpm@latest --activate

# 3. 작업 디렉토리 설정
WORKDIR /app

# 4. 파일 복사 (의존성 설치를 위해 전체 복사)
COPY . .

# 5. 의존성 설치
RUN pnpm install --frozen-lockfile

# 6. 각 워크스페이스 빌드 (에러 무시 옵션 포함)
RUN pnpm --filter @workspace/db run build 2>/dev/null || true
RUN pnpm --filter @workspace/api-zod run build 2>/dev/null || true
RUN pnpm --filter @workspace/integrations-anthropic-ai run build 2>/dev/null || true
RUN pnpm --filter @workspace/integrations-openai-ai-server run build 2>/dev/null || true
RUN pnpm --filter @workspace/api-client-react run build 2>/dev/null || true

# 7. 메인 서비스 빌드 및 정적 파일 복사
RUN PORT=3000 BASE_PATH=/ pnpm --filter @workspace/crypto-trader run build
RUN mkdir -p artifacts/api-server/public && cp -r artifacts/crypto-trader/dist/public/* artifacts/api-server/public/
RUN pnpm --filter @workspace/api-server run build

# 8. 포트 설정 및 실행
EXPOSE 8080
CMD ["pnpm", "--filter", "@workspace/api-server", "run", "start"]
