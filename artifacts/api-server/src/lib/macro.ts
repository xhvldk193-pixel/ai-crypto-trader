// artifacts/api-server/src/lib/macro.ts

import { logger } from "./logger";

interface MacroData {
  fearGreedIndex: number | null;
  fearGreedLabel: string | null;
  btcDominance: number | null;
  stablecoinMarketCap: number | null; // USD billions
  dxy: number | null;                  // 달러 인덱스
  realRate10y: number | null;          // 10Y 실질금리
  cachedAt: number;
}

let cache: MacroData | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1시간
// ✅ 외부 API 타임아웃 — 네트워크 문제 시 무한 대기 방지
const FETCH_TIMEOUT_MS = 5_000;

async function fetchWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFearGreed(): Promise<Pick<MacroData, "fearGreedIndex" | "fearGreedLabel">> {
  try {
    const res = await fetchWithTimeout("https://api.alternative.me/fng/?limit=1");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const d = json?.data?.[0];
    return {
      fearGreedIndex: d ? Number(d.value) : null,
      fearGreedLabel: d?.value_classification ?? null,
    };
  } catch (err) {
    logger.warn({ err: String(err) }, "Fear & Greed 조회 실패");
    return { fearGreedIndex: null, fearGreedLabel: null };
  }
}

async function fetchCoinGecko(): Promise<{ btcDominance: number | null }> {
  try {
    const res = await fetchWithTimeout("https://api.coingecko.com/api/v3/global");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const dom = json?.data?.market_cap_percentage?.btc;
    return { btcDominance: dom ? Number(dom.toFixed(2)) : null };
  } catch (err) {
    logger.warn({ err: String(err) }, "CoinGecko 조회 실패");
    return { btcDominance: null };
  }
}

async function fetchDeFiLlama(): Promise<{ stablecoinMarketCap: number | null }> {
  try {
    const res = await fetchWithTimeout("https://stablecoins.llama.fi/stablecoins?includePrices=true");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    type PeggedAsset = { circulating?: { peggedUSD?: number } };
    const assets = (json?.peggedAssets ?? []) as PeggedAsset[];
    const total = assets.reduce((sum, a) => sum + (a?.circulating?.peggedUSD ?? 0), 0);
    return { stablecoinMarketCap: total > 0 ? Number((total / 1e9).toFixed(2)) : null };
  } catch (err) {
    logger.warn({ err: String(err) }, "DeFiLlama 조회 실패");
    return { stablecoinMarketCap: null };
  }
}

async function fetchFred(series: string, apiKey: string): Promise<number | null> {
  try {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${apiKey}&sort_order=desc&limit=1&file_type=json`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const val = json?.observations?.[0]?.value;
    return val && val !== "." ? Number(val) : null;
  } catch (err) {
    logger.warn({ err: String(err), series }, "FRED 조회 실패");
    return null;
  }
}

export async function getMacroContext(): Promise<MacroData> {
  const now = Date.now();
  if (cache && now - cache.cachedAt < CACHE_TTL_MS) return cache;

  const fredKey = process.env.FRED_API_KEY ?? "";

  const [fg, cg, dl, dxy, realRate] = await Promise.all([
    fetchFearGreed(),
    fetchCoinGecko(),
    fetchDeFiLlama(),
    fredKey ? fetchFred("DTWEXBGS", fredKey) : Promise.resolve(null),
    fredKey ? fetchFred("DFII10", fredKey) : Promise.resolve(null),
  ]);

  const next: MacroData = {
    ...fg,
    ...cg,
    ...dl,
    dxy,
    realRate10y: realRate,
    cachedAt: now,
  };

  // ✅ 모든 데이터가 null이면 캐싱하지 않음 — 다음 호출에서 재시도 가능
  const hasAnyData =
    next.fearGreedIndex !== null ||
    next.btcDominance !== null ||
    next.stablecoinMarketCap !== null ||
    next.dxy !== null ||
    next.realRate10y !== null;

  if (hasAnyData) {
    cache = next;
  } else {
    logger.warn("모든 거시경제 데이터 조회 실패 — 캐시 건너뜀, 다음 요청 시 재시도");
  }

  return next;
}

export function formatMacroForPrompt(m: MacroData): string {
  const lines: string[] = [];

  if (m.fearGreedIndex !== null)
    lines.push(`Fear & Greed Index: ${m.fearGreedIndex}/100 (${m.fearGreedLabel}) — ${m.fearGreedIndex < 30 ? "극도 공포, 잠재적 매수 기회" : m.fearGreedIndex > 70 ? "극도 탐욕, 과열 주의" : "중립"}`);

  if (m.btcDominance !== null)
    lines.push(`BTC 도미넌스: ${m.btcDominance}% — ${m.btcDominance > 55 ? "알트 자금 BTC 집중" : "알트 시즌 가능성"}`);

  if (m.stablecoinMarketCap !== null)
    lines.push(`스테이블코인 시총: $${m.stablecoinMarketCap}B — ${m.stablecoinMarketCap > 180 ? "유동성 풍부" : "유동성 타이트"}`);

  if (m.dxy !== null)
    lines.push(`달러 인덱스 (DXY): ${m.dxy} — ${m.dxy > 104 ? "달러 강세, BTC 부정적" : m.dxy < 100 ? "달러 약세, BTC 우호적" : "중립"}`);

  if (m.realRate10y !== null)
    lines.push(`10Y 실질금리: ${m.realRate10y}% — ${m.realRate10y > 2 ? "고금리, 위험자산 압력" : m.realRate10y < 0 ? "마이너스 금리, BTC 우호적" : "중립"}`);

  return lines.length > 0 ? lines.join("\n") : "  (거시경제 데이터 없음)";
}
