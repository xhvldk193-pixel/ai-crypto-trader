import { useGetMarketTicker, useGetPortfolioSummary, useGetBotStatus, useGetBotLogs } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatUsd, formatPercent, formatDate } from "@/lib/format";
import { Activity, TrendingUp, TrendingDown, Bot } from "lucide-react";

export default function Dashboard() {
  const { data: ticker, isLoading: isTickerLoading } = useGetMarketTicker(
    { symbol: "BTC/USDT" },
    { query: { refetchInterval: 5000 } as never }
  );

  const { data: summary, isLoading: isSummaryLoading } = useGetPortfolioSummary();
  const { data: botStatus, isLoading: isBotLoading } = useGetBotStatus();
  const { data: logs, isLoading: isLogsLoading } = useGetBotLogs({ limit: 5 });

  const isUp = ticker && ticker.changePercent24h >= 0;

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">대시보드</h1>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">BTC/USDT 가격</CardTitle>
            {isUp ? <TrendingUp className="h-4 w-4 text-positive" /> : <TrendingDown className="h-4 w-4 text-negative" />}
          </CardHeader>
          <CardContent>
            {isTickerLoading ? <Skeleton className="h-8 w-32" /> : (
              <>
                <div className="text-2xl font-bold font-mono">{formatUsd(ticker?.price)}</div>
                <p className={`text-xs ${isUp ? "text-positive" : "text-negative"}`}>
                  {isUp ? "+" : ""}{formatPercent(ticker?.changePercent24h)} (24h)
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">총 자산</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isSummaryLoading ? <Skeleton className="h-8 w-32" /> : (
              <>
                <div className="text-2xl font-bold font-mono">{formatUsd(summary?.totalValue)}</div>
                <p className={`text-xs ${summary && summary.totalPnlPercent >= 0 ? "text-positive" : "text-negative"}`}>
                  {summary && summary.totalPnlPercent >= 0 ? "+" : ""}{formatPercent(summary?.totalPnlPercent)} 전체
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">봇 상태</CardTitle>
            <Bot className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isBotLoading ? <Skeleton className="h-8 w-32" /> : (
              <>
                <div className={`text-2xl font-bold font-mono ${botStatus?.running ? 'text-positive' : 'text-muted-foreground'}`}>
                  {botStatus?.running ? "실행 중" : "중지됨"}
                </div>
                <p className="text-xs text-muted-foreground">
                  거래: {botStatus?.executedTrades || 0}건 | 가동: {botStatus?.uptime ? `${Math.floor(botStatus.uptime / 3600)}시간` : '0시간'}
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">24h 거래량</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isTickerLoading ? <Skeleton className="h-8 w-32" /> : (
              <>
                <div className="text-2xl font-bold font-mono">
                  {ticker?.volume24h ? `$${(ticker.volume24h / 1_000_000_000).toFixed(1)}B` : '-'}
                </div>
                <p className="text-xs text-muted-foreground">
                  고가: {formatUsd(ticker?.high24h)} / 저가: {formatUsd(ticker?.low24h)}
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <Card className="col-span-4">
          <CardHeader>
            <CardTitle>최근 활동</CardTitle>
          </CardHeader>
          <CardContent>
            {isLogsLoading ? <Skeleton className="h-40 w-full" /> : logs?.logs?.length ? (
              <div className="space-y-4">
                {logs.logs.map((log) => (
                  <div key={log.id} className="flex items-center gap-4 text-sm font-mono">
                    <span className="text-muted-foreground w-32 shrink-0">{formatDate(log.timestamp)}</span>
                    <span className={`w-20 shrink-0 ${
                      log.level === 'error' ? 'text-destructive' : 
                      log.level === 'warning' ? 'text-warning' : 
                      log.level === 'trade' ? 'text-primary' : 'text-muted-foreground'
                    }`}>[{log.level.toUpperCase()}]</span>
                    <span className="flex-1 truncate">{log.message}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-sm text-muted-foreground">
                봇을 시작하면 여기에 활동 로그가 표시됩니다.
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-3">
          <CardHeader>
            <CardTitle>포트폴리오 요약</CardTitle>
          </CardHeader>
          <CardContent>
            {isSummaryLoading ? <Skeleton className="h-40 w-full" /> : summary ? (
              <div className="space-y-4">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">총 거래 수</span>
                  <span className="font-medium">{summary.totalTrades}건</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">총 P&L</span>
                  <span className={`font-medium font-mono ${summary.totalPnl >= 0 ? 'text-positive' : 'text-negative'}`}>
                    {summary.totalPnl >= 0 ? '+' : ''}{formatUsd(summary.totalPnl)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">수익률</span>
                  <span className={`font-medium ${summary.totalPnlPercent >= 0 ? 'text-positive' : 'text-negative'}`}>
                    {summary.totalPnlPercent >= 0 ? '+' : ''}{formatPercent(summary.totalPnlPercent)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">수익 거래</span>
                  <span className="font-medium">{summary.profitableTrades}건</span>
                </div>
              </div>
            ) : (
              <div className="text-center py-8 text-sm text-muted-foreground">
                데이터 없음
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
