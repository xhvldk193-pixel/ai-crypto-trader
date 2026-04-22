// artifacts/api-server/src/lib/macro.ts

interface MacroData {
  fearGreedIndex: number | null;
  fearGreedLabel: string | null;
  btcDominance: number | null;
  stablecoinMarketCap: number | null; // USD billions
  dxy: number | null;       // 달러 인덱스
  realRate10y: number | null; // 10Y 실질금리
  cachedAt: number;
}

let cache: MacroData | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1시간

async function fetchFearGreed(): Promise<Pick<MacroData, "fearGreedIndex" | "fearGreedLabel">> {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1");
    const json = await res.json();
    const d = json?.data?.[0];
    return {
      fearGreedIndex: d ? Number(d.value) : null,
      fearGreedLabel: d?.value_classification ?? null,
    };
  } catch {
    return { fearGreedIndex: null, fearGreedLabel: null };
  }
}

async function fetchCoinGecko(): Promise<{ btcDominance: number | null }> {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/global");
    const json = await res.json();
    const dom = json?.data?.market_cap_percentage?.btc;
    return { btcDominance: dom ? Number(dom.toFixed(2)) : null };
  } catch {
    return { btcDominance: null };
  }
}

async function fetchDeFiLlama(): Promise<{ stablecoinMarketCap: number | null }> {
  try {
    const res = await fetch("https://stablecoins.llama.fi/stablecoins?includePrices=true");
    const json = await res.json();
    const total = (json?.peggedAssets ?? []).reduce((sum: number, a: any) => {
      return sum + (a?.circulating?.peggedUSD ?? 0);
    }, 0);
    return { stablecoinMarketCap: total > 0 ? Number((total / 1e9).toFixed(2)) : null };
  } catch {
    return { stablecoinMarketCap: null };
  }
}

async function fetchFred(series: string, apiKey: string): Promise<number | null> {
  try {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${apiKey}&sort_order=desc&limit=1&file_type=json`;
    const res = await fetch(url);
    const json = await res.json();
    const val = json?.observations?.[0]?.value;
    return val && val !== "." ? Number(val) : null;
  } catch {
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

  cache = {
    ...fg,
    ...cg,
    ...dl,
    dxy,
    realRate10y: realRate,
    cachedAt: now,
  };

  return cache;
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