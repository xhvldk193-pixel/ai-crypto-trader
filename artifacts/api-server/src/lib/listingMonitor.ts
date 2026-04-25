import { logger } from "./logger";
import { db } from "@workspace/db";
import { listingEventsTable } from "@workspace/db";
import { desc } from "drizzle-orm";

export interface ListingEvent {
  symbol: string;
  baseAsset: string;
  exchange: string;
  title: string;
  url: string;
  detectedAt: number;
}

type ListingHandler = (event: ListingEvent) => Promise<void>;

const LISTING_KEYWORDS = ["will list", "lists", "new listing", "will add", "adds", "launch", "introducing"];
const EXCLUDE_KEYWORDS = ["delist", "remove", "suspend", "leveraged", "margin only", "futures only", "options", "seed tag"];
const IGNORE_WORDS = new Set(["BINANCE","WILL","LIST","LISTS","ADDS","ADD","AND","THE","FOR","NEW","NOW","USDT","USD","BTC","ETH","BNB","SPOT","FUTURES","WITH","INTO","TRADING","PAIRS","PAIR","TOKEN","TOKENS","COIN","COINS","LAUNCH","LISTING","INTRODUCING","SIMPLE","EARN","LAUNCHPOOL","LAUNCHPAD","NFT","DAO","DEX"]);

function extractSymbols(title: string): string[] {
  const upper = title.toUpperCase();
  const matches = [...upper.matchAll(/\b([A-Z]{2,10})\b/g)];
  const candidates = matches.map(m => m[1]).filter(s => s.length >= 2 && s.length <= 10 && !IGNORE_WORDS.has(s));
  return [...new Set(candidates)];
}

function isListingAnnouncement(title: string): boolean {
  const lower = title.toLowerCase();
  return LISTING_KEYWORDS.some(kw => lower.includes(kw)) && !EXCLUDE_KEYWORDS.some(kw => lower.includes(kw));
}

async function fetchBinanceAnnouncements() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const url = "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=10&catalogId=48";
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return (json?.data?.articles ?? []) as Array<{ title: string; code: string; releaseDate: number }>;
  } catch (err) {
    logger.warn({ err: String(err) }, "바이낸스 공지 조회 실패");
    return [];
  } finally { clearTimeout(t); }
}

export class ListingMonitor {
  private running = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private handlers: ListingHandler[] = [];
  private seenCodes = new Set<string>();
  private readonly pollIntervalMs: number;

  constructor(pollIntervalSeconds = 10) { this.pollIntervalMs = pollIntervalSeconds * 1000; }

  onListing(handler: ListingHandler) { this.handlers.push(handler); }

  async start() {
    if (this.running) return;
    this.running = true;
    try {
      const recent = await db.select().from(listingEventsTable).orderBy(desc(listingEventsTable.detectedAt)).limit(100);
      for (const r of recent) this.seenCodes.add(r.sourceUrl);
    } catch {}
    logger.info("상장 모니터 시작");
    await this.poll();
    this.intervalId = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
    logger.info("상장 모니터 정지");
  }

  isRunning() { return this.running; }

  private async poll() {
    if (!this.running) return;
    try {
      const articles = await fetchBinanceAnnouncements();
      for (const article of articles) {
        const url = `https://www.binance.com/en/support/announcement/${article.code}`;
        if (this.seenCodes.has(url)) continue;
        if (!isListingAnnouncement(article.title)) continue;
        this.seenCodes.add(url);
        const symbols = extractSymbols(article.title);
        if (symbols.length === 0) continue;
        logger.info({ title: article.title, symbols }, "바이낸스 상장 공지 감지!");
        for (const baseAsset of symbols) {
          const symbol = `${baseAsset}/USDT`;
          try {
            await db.insert(listingEventsTable).values({ symbol, baseAsset, sourceExchange: "Binance", title: article.title, sourceUrl: url, detectedAt: new Date(), status: "detected" });
          } catch {}
          for (const handler of this.handlers) {
            handler({ symbol, baseAsset, exchange: "Binance", title: article.title, url, detectedAt: Date.now() }).catch(err => logger.error({ err, symbol }, "상장 핸들러 오류"));
          }
        }
      }
    } catch (err) { logger.error({ err }, "상장 모니터 폴링 오류"); }
  }
}

export const listingMonitor = new ListingMonitor(10);
