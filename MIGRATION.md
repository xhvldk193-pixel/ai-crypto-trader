# 수정본 적용 가이드

이 패치는 실거래 안정성, 봇 로직, 보안, UX 4가지 카테고리에 걸쳐 18개 항목을 수정합니다.
원본 리포에 덮어쓴 뒤 README 하단의 환경변수 / 클라이언트 변경사항을 반드시 확인하세요.

## 파일 구조

수정된 파일들은 원본과 동일한 경로 구조로 배치되어 있습니다.
루트에 이 가이드(MIGRATION.md)만 추가되어 있고, 나머지는 모두 기존 파일 교체입니다.

```
Dockerfile                                      # Node 22 → 24
package.json                                    # engines 필드 추가
artifacts/api-server/
├── scripts/hash-password.mjs                   # 🆕 비밀번호 해시 생성 CLI
└── src/
    ├── lib/
    │   ├── auth.ts                             # scrypt 해시 기반 인증
    │   ├── botManager.ts                       # 로직 개선 + SSE emit
    │   ├── events.ts                           # 🆕 이벤트 버스
    │   ├── exchange.ts                         # Bitget 헤지 모드 파라미터
    │   └── macro.ts                            # any 제거
    └── routes/
        └── bot.ts                              # SSE 스트리밍 엔드포인트
```

## 🔴 배포 전 반드시 할 일

### 1. 비밀번호를 해시로 전환 (권장)

```bash
cd artifacts/api-server
node scripts/hash-password.mjs "여기에_실제_비밀번호"
# 출력: scrypt$16384$8$1$<salt>$<hash>
```

출력된 문자열을 그대로 복사해서 환경변수 `OWNER_PASSWORD_HASH` 에 등록하고,
기존의 평문 `OWNER_PASSWORD` 는 삭제하세요.

**평문을 유지해도 호환은 되지만** 서버 기동 시 경고 로그가 찍힙니다.

### 2. Bitget 포지션 모드 확인

수정본은 **헤지 모드(hedge mode / two-way)** 를 가정합니다.
Bitget 앱/웹에서 USDT-M 선물 설정 → 포지션 모드를 "양방향(Hedge Mode)" 으로 맞춰 주세요.
원웨이 모드를 쓰고 싶다면 `exchange.ts` 의 `tradeSide`/`holdSide` 로직을 조건부로 수정해야 합니다.

### 3. 프론트엔드: 폴링 → SSE 전환 (선택사항)

기존 `/api/bot/status` REST 폴링은 **여전히 동작**하므로 프론트엔드 변경은 선택사항입니다.
실시간성이 필요하면 SSE 를 사용하세요.

```ts
// 기존 폴링 (그대로 유지 가능)
setInterval(() => fetch('/api/bot/status').then(...), 3000);

// 새 SSE (권장)
const es = new EventSource('/api/bot/stream', { withCredentials: true });
es.onmessage = (e) => {
  const evt = JSON.parse(e.data);
  switch (evt.type) {
    case 'status':   /* running, halted, lastSignal, ... */ break;
    case 'log':      /* level, message, symbol, action */    break;
    case 'position': /* opened / closed / partial-tp / trailing-updated */ break;
  }
};
```

연결은 세션 쿠키로 인증되며, 백엔드는 15초마다 heartbeat comment(`: heartbeat`)
를 보내므로 Railway/nginx 프록시 타임아웃에 걸리지 않습니다.

## 🟡 알아두면 좋은 동작 변경

### botManager 틱 동작
- `tick` 이 한 바퀴 돌 때마다 `manageActivePositions` 를 **강제 호출** 합니다.
  이전에는 별도 30초 인터벌에만 의존했으므로 진입 직후 최대 30초 청산 지연이 있었습니다.
- 일일 손실 한도(`halted`) 에 도달해도 **기존 포지션 TP/SL 은 계속 체크** 합니다.
  신규 진입만 차단됩니다.

### 설정 캐시
- 이전: 매 tick 마다 캐시를 무효화(= 매번 DB 조회) — 캐시 의미 없음
- 이후: 30초 TTL + `reloadConfig()` / 일일 리셋 시 명시적 무효화
  PUT `/api/bot/config` 요청은 내부적으로 `reloadConfig()` 를 호출하므로 즉시 반영됩니다.

### AI 의사결정 하한
- 이전: `expectedMovePercent` 하한을 고정 0.2% 로 클램프
- 이후: `max(0.1%, ATR × 0.3)` — 저변동성 구간에서 과도한 진입 유도 제거

### Bitget 주문 파라미터
- 이전: `{ oneWayMode: false, holdSide }` (비표준 키)
- 이후: `{ holdSide, tradeSide: "open"|"close", reduceOnly? }` (ccxt 공식 권장)
- 기타 거래소(Binance, Bybit 등) 는 `positionSide` 사용 — 거래소별 분기

## 🟢 기타 개선

- 데모 모드 `getBalance.totalUsd` 가 이제 명확히 `demoWallet + 미실현 손익` 을 반환
- `fetchPositions` 의 `side` 를 소문자화해서 거래소가 "LONG"/"Short" 등 반환해도 대응
- `fetchOhlcvRange` 가 동일 `since` 를 두 번 받으면 무한루프 대신 종료
- `macro.ts` 에서 `any` 제거

## 아직 남은 권장 사항

이번 패치에 포함되지 않은, 시간이 더 있을 때 추가하면 좋을 항목:

- [ ] 리포 루트의 중복 `divergence.ts`, `index.ts` 확인 후 제거
- [ ] `downloads/`, `exports/`, `attached_assets/` 디렉터리 `.gitignore`
- [ ] 다중 인스턴스 확장 시 `lib/events.ts` 를 Redis pub/sub 으로 교체
- [ ] SSE 클라이언트용 React 훅 (`useBotEvents`) 추가
- [ ] 분리된 단위 테스트 (특히 `sanitizeDecision`, `analyzeDivergences`)
