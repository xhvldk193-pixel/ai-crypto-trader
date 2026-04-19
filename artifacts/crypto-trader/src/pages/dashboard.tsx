import { useGetMarketTicker, useGetPortfolioSummary, useGetBotStatus, useGetBotLogs, useGetLatestAiSignal, useGetActivePositions } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { formatUsd, formatPercent, formatDate } from "@/lib/format";
import { Activity, TrendingUp, TrendingDown, Bot, Brain, Target } from "lucide-react";

export default function Dashboard() {
  const { data: ticker, isLoading: isTickerLoading } = useGetMarketTicker(
    { symbol: "BTC/USDT" },
    { query: { refetchInterval: 5000 } as never }
  );

  const { data: summary, isLoading: isSummaryLoading } = useGetPortfolioSummary();
  const { data: botStatus, isLoading: isBotLoading } = useGetBotStatus({ query: { refetchInterval: 5000 } as never });
  const { data: logs, isLoading: isLogsLoading } = useGetBotLogs({ limit: 5 }, { query: { refetchInterval: 5000 } as never });
  const { data: latestSignalData } = useGetLatestAiSignal({ query: { refetchInterval: 5000 } as never });
  const { data: activeData } = useGetActivePositions({ query: { refetchInterval: 5000 } as never });
  const latestSignal = latestSignalData?.signal;
  const activePositions = activeData?.positions ?? [];

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

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2"><Brain className="h-4 w-4 text-primary" /> 최근 AI 시그널</CardTitle>
              <CardDescription>봇이 분석한 가장 최근 다이버전스 신호</CardDescription>
            </div>
            {latestSignal && (
              <Badge variant={latestSignal.action === "BUY" ? "default" : latestSignal.action === "SELL" ? "destructive" : "secondary"}>
                {latestSignal.action}
              </Badge>
            )}
          </CardHeader>
          <CardContent>
            {!latestSignal ? (
              <div className="text-center py-8 text-sm text-muted-foreground">아직 분석된 신호가 없습니다. 봇을 시작하세요.</div>
            ) : (
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{latestSignal.symbol} · {latestSignal.timeframe}</span>
                  <span className="text-xs text-muted-foreground">{formatDate(latestSignal.createdAt ?? Date.now())}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">현재가 / 진입가</span>
                  <span className="font-mono">{formatUsd(latestSignal.currentPrice)} / {formatUsd(latestSignal.entryPrice ?? latestSignal.currentPrice)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">예상 변동</span>
                  <span className={`font-mono font-bold ${(latestSignal.expectedMovePercent ?? 0) >= 0 ? 'text-positive' : 'text-negative'}`}>
                    {(latestSignal.expectedMovePercent ?? 0) >= 0 ? "+" : ""}{(latestSignal.expectedMovePercent ?? 0).toFixed(2)}%
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">목표가 (TP)</span>
                  <span className="font-mono text-positive">{latestSignal.takeProfit ? formatUsd(latestSignal.takeProfit) : "-"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">손절가 (SL)</span>
                  <span className="font-mono text-negative">{latestSignal.stopLoss ? formatUsd(latestSignal.stopLoss) : "-"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">신뢰도 / 리스크</span>
                  <span>{((latestSignal.confidence ?? 0) * 100).toFixed(0)}% · {latestSignal.riskLevel}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">강세 / 약세</span>
                  <span>{latestSignal.bullishCount} / {latestSignal.bearishCount}</span>
                </div>
                {latestSignal.reasoning && (
                  <div className="pt-2 border-t text-xs text-muted-foreground leading-relaxed">{latestSignal.reasoning}</div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Target className="h-4 w-4 text-primary" /> 활성 포지션</CardTitle>
            <CardDescription>AI가 설정한 익절/손절을 자동 추적 중</CardDescription>
          </CardHeader>
          <CardContent>
            {activePositions.length === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground">현재 보유 중인 포지션이 없습니다.</div>
            ) : (
              <div className="space-y-4">
                {activePositions.map((p) => (
                  <div key={p.id} className="border rounded-md p-3 space-y-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-bold">{p.symbol}</span>
                      <Badge variant={p.side === "long" ? "default" : "destructive"}>{p.side === "long" ? "롱" : "숏"}</Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                      <div><span className="text-muted-foreground">진입: </span>{formatUsd(p.entryPrice)}</div>
                      <div><span className="text-muted-foreground">현재: </span>{formatUsd(p.currentPrice)}</div>
                      <div><span className="text-muted-foreground">TP: </span><span className="text-positive">{formatUsd(p.takeProfit)}</span></div>
                      <div><span className="text-muted-foreground">SL: </span><span className="text-negative">{formatUsd(p.stopLoss)}</span></div>
                    </div>
                    <div className="flex items-center justify-between pt-1 border-t">
                      <span className="text-xs text-muted-foreground">미실현 P&L</span>
                      <span className={`font-mono font-bold ${p.unrealizedPnl >= 0 ? 'text-positive' : 'text-negative'}`}>
                        {p.unrealizedPnl >= 0 ? "+" : ""}{formatUsd(p.unrealizedPnl)} ({p.unrealizedPnlPercent >= 0 ? "+" : ""}{p.unrealizedPnlPercent.toFixed(2)}%)
                      </span>
                    </div>
                  </div>
                ))}
              </div>
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
