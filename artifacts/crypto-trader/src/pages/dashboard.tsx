import { useMemo } from "react";
import { useGetMarketTicker, useGetPortfolioSummary, useGetBotStatus, useGetBotLogs, useGetLatestAiSignalsBySymbol, useGetActivePositions, useGetPnlTimeseries } from "@workspace/api-client-react";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid } from "recharts";
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
  const { data: signalsData } = useGetLatestAiSignalsBySymbol({ query: { refetchInterval: 5000 } as never });
  const { data: activeData } = useGetActivePositions({ query: { refetchInterval: 5000 } as never });
  const { data: pnlData } = useGetPnlTimeseries({ days: 30 }, { query: { refetchInterval: 30000 } as never });

  const cumulativeChart = useMemo(
    () => (pnlData?.cumulative ?? []).map((p) => ({
      ts: p.timestamp,
      label: new Date(p.timestamp).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" }),
      cum: Number(p.cumulativePnl.toFixed(2)),
    })),
    [pnlData]
  );
  const dailyChart = useMemo(
    () => (pnlData?.daily ?? []).map((d) => ({
      ts: d.timestamp,
      label: new Date(d.timestamp).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" }),
      pnl: Number(d.pnl.toFixed(2)),
      winRate: Number((d.winRate * 100).toFixed(1)),
      trades: d.trades,
    })),
    [pnlData]
  );
  const signals = useMemo(
    () => [...(signalsData?.signals ?? [])].sort((a, b) => (a.symbol ?? "").localeCompare(b.symbol ?? "")),
    [signalsData]
  );
  const activePositions = useMemo(
    () => [...(activeData?.positions ?? [])].sort((a, b) => (a.symbol ?? "").localeCompare(b.symbol ?? "")),
    [activeData]
  );

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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Brain className="h-4 w-4 text-primary" /> 심볼별 최근 AI 시그널</CardTitle>
          <CardDescription>감시 중인 각 페어의 가장 최근 다이버전스 신호</CardDescription>
        </CardHeader>
        <CardContent>
          {signals.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">아직 분석된 신호가 없습니다. 봇을 시작하세요.</div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {signals.map((s) => (
                <div key={s.id} className="border rounded-md p-3 space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-bold">{s.symbol} <span className="text-xs text-muted-foreground">· {s.timeframe}</span></span>
                    <Badge variant={s.action === "BUY" ? "default" : s.action === "SELL" ? "destructive" : "secondary"}>{s.action}</Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs font-mono">
                    <div><span className="text-muted-foreground">현재: </span>{formatUsd(s.currentPrice)}</div>
                    <div><span className="text-muted-foreground">진입: </span>{formatUsd(s.entryPrice ?? s.currentPrice)}</div>
                    <div><span className="text-muted-foreground">TP: </span><span className="text-positive">{s.takeProfit ? formatUsd(s.takeProfit) : "-"}</span></div>
                    <div><span className="text-muted-foreground">SL: </span><span className="text-negative">{s.stopLoss ? formatUsd(s.stopLoss) : "-"}</span></div>
                    <div className={`col-span-2 ${(s.expectedMovePercent ?? 0) >= 0 ? 'text-positive' : 'text-negative'}`}>
                      <span className="text-muted-foreground">예상: </span>{(s.expectedMovePercent ?? 0) >= 0 ? "+" : ""}{(s.expectedMovePercent ?? 0).toFixed(2)}%
                      <span className="text-muted-foreground"> · 신뢰도 </span>{((s.confidence ?? 0) * 100).toFixed(0)}%
                    </div>
                  </div>
                  <div className="text-[10px] text-muted-foreground">{formatDate(s.createdAt ?? Date.now())} · 강 {s.bullishCount} / 약 {s.bearishCount}</div>
                  {s.reasoning && <div className="pt-1 border-t text-xs text-muted-foreground leading-relaxed line-clamp-3">{s.reasoning}</div>}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><TrendingUp className="h-4 w-4 text-primary" /> PnL 추이 (최근 30일)</CardTitle>
          <CardDescription>실현 손익 누적 곡선과 일별 승률</CardDescription>
        </CardHeader>
        <CardContent>
          {cumulativeChart.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              아직 실현된 거래 내역이 없습니다.
            </div>
          ) : (
            <div className="grid gap-6 md:grid-cols-2">
              <div>
                <div className="text-xs text-muted-foreground mb-2">누적 PnL ($)</div>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={cumulativeChart} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 12 }}
                      formatter={(v: number) => [`$${v.toFixed(2)}`, "누적 PnL"]}
                    />
                    <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                    <Line type="monotone" dataKey="cum" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-2">일별 승률 (%) · 일별 PnL ($)</div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={dailyChart} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis yAxisId="left" tick={{ fontSize: 10 }} />
                    <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} domain={[0, 100]} />
                    <Tooltip
                      contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 12 }}
                      formatter={(v: number, name: string) => name === "winRate" ? [`${v.toFixed(1)}%`, "승률"] : [`$${v.toFixed(2)}`, "PnL"]}
                    />
                    <ReferenceLine yAxisId="left" y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                    <Bar yAxisId="left" dataKey="pnl" fill="hsl(var(--primary))" />
                    <Line yAxisId="right" type="monotone" dataKey="winRate" stroke="hsl(var(--positive, 142 76% 36%))" strokeWidth={2} dot={{ r: 3 }} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Target className="h-4 w-4 text-primary" /> 심볼별 활성 포지션</CardTitle>
          <CardDescription>AI가 설정한 익절/손절을 자동 추적 중</CardDescription>
        </CardHeader>
        <CardContent>
          {activePositions.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">현재 보유 중인 포지션이 없습니다.</div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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
