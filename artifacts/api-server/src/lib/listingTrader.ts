type ListingEvent = { symbol: string; [key: string]: unknown };

export interface ActiveTrade {
  symbol: string;
  entryPrice: number;
  takeProfit: number;
  stopLoss: number;
  entryTime: number;
  maxHoldMs: number;
  announcementTitle: string;
}

export interface ListingTraderConfig {
  enabled: boolean;
  tradeAmountUsdt: number;
  takeProfitPercent: number;
  stopLossPercent: number;
  maxHoldHours: number;
  leverage: number;
  maxWaitSeconds: number;
  checkIntervalMs: number;
}

let config: ListingTraderConfig = {
  enabled: false,
  tradeAmountUsdt: 100,
  takeProfitPercent: 10,
  stopLossPercent: 5,
  maxHoldHours: 4,
  leverage: 3,
  maxWaitSeconds: 60,
  checkIntervalMs: 2000,
};

const activeTrades: ActiveTrade[] = [];

export function getConfig(): ListingTraderConfig {
  return { ...config };
}

export function updateConfig(update: Partial<ListingTraderConfig>): void {
  config = { ...config, ...update };
}

export function getActiveTrades(): ActiveTrade[] {
  return [...activeTrades];
}

export async function restoreFromDb(): Promise<void> {
  // TODO: restore listing trades from DB
}

export async function handleListingEvent(event: ListingEvent): Promise<void> {
  // TODO: handle a new listing event
}

let positionMonitorInterval: ReturnType<typeof setInterval> | null = null;

export function startPositionMonitor(): void {
  if (positionMonitorInterval) return;
  positionMonitorInterval = setInterval(() => {
    // TODO: monitor open listing positions
  }, config.checkIntervalMs);
}

export function stopPositionMonitor(): void {
  if (positionMonitorInterval) {
    clearInterval(positionMonitorInterval);
    positionMonitorInterval = null;
  }
}
