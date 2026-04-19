import { useState } from "react";
import { useRunBacktest, useGetMarketSymbols } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatUsd, formatNumber } from "@/lib/format";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { TrendingUp, TrendingDown, Activity, Play } from "lucide-react";

type Timeframe = "15m" | "1h" | "4h" | "1d";

function formatDate(ts: number) {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function Backtest() {
  const { data: symbolsData } = useGetMarketSymbols();
  const symbols = symbolsData?.symbols || ["BTC/USDT", "ETH/USDT", "SOL/USDT"];

  const [symbol, setSymbol] = useState("BTC/USDT");
  const [timeframe, setTimeframe] = useState<Timeframe>("15m");
  const [candleCount, setCandleCount] = useState(500);
  const [tradeAmountUsd, setTradeAmountUsd] = useState(100);
  const [stopLossPercent, setStopLossPercent] = useState(2);
  const [takeProfitPercent, setTakeProfitPercent] = useState(5);
  const [feePercent, setFeePercent] = useState(0.1);

  const runBacktest = useRunBacktest();
  const result = runBacktest.data;
  const isLoading = runBacktest.isPending;

  const handleRun = () => {
    runBacktest.mutate({
      data: {
        symbol,
        timeframe,
        candleCount,
        tradeAmountUsd,
        stopLossPercent,
        takeProfitPercent,
        feePercent,
        warmupBars: 60,
        windowBars: 100,
      },
    });
  };

  const equityChart = (result?.equityCurve ?? []).map((p) => ({
    time: p.time,
    label: formatDate(p.time),
    equity: p.equity,
  }));

  const totalReturn = result?.metrics.totalReturnPercent ?? 0;
  const isProfitable = totalReturn >= 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">백테스트</h1>
          <p className="text-muted-foreground">과거 데이터로 다이버전스 전략을 검증합니다</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-4">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>설정</CardTitle>
            <CardDescription>전략 파라미터</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>심볼</Label>
              <Select value={symbol} onValueChange={setSymbol}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {symbols.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>타임프레임</Label>
              <Select value={timeframe} onValueChange={(v) => setTimeframe(v as Timeframe)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="15m">15분</SelectItem>
                  <SelectItem value="1h">1시간</SelectItem>
                  <SelectItem value="4h">4시간</SelectItem>
                  <SelectItem value="1d">1일</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>캔들 개수 (100-1000)</Label>
              <Input type="number" min={100} max={1000} value={candleCount} onChange={(e) => setCandleCount(Number(e.target.value))} />
            </div>
            <div className="space-y-2">
              <Label>거래 금액 (USDT)</Label>
              <Input type="number" min={10} step={10} value={tradeAmountUsd} onChange={(e) => setTradeAmountUsd(Number(e.target.value))} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-2">
                <Label>손절 (%)</Label>
                <Input type="number" step="0.1" value={stopLossPercent} onChange={(e) => setStopLossPercent(Number(e.target.value))} />
              </div>
              <div className="space-y-2">
                <Label>익절 (%)</Label>
                <Input type="number" step="0.1" value={takeProfitPercent} onChange={(e) => setTakeProfitPercent(Number(e.target.value))} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>수수료 (%)</Label>
              <Input type="number" step="0.01" value={feePercent} onChange={(e) => setFeePercent(Number(e.target.value))} />
            </div>
            <Button onClick={handleRun} disabled={isLoading} className="w-full">
              <Play className="mr-2 h-4 w-4" />
              {isLoading ? "실행 중..." : "백테스트 실행"}
            </Button>
            {runBacktest.isError && (
              <p className="text-xs text-negative">실패: 캔들 수를 줄이거나 다시 시도하세요.</p>
            )}
          </CardContent>
        </Card>

        <div className="lg:col-span-3 space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card>
              <CardContent className="pt-6">
                <div className="text-xs text-muted-foreground mb-1">총 수익률</div>
                {isLoading ? <Skeleton className="h-7 w-24" /> : (
                  <div className={`text-2xl font-bold font-mono ${isProfitable ? "text-positive" : "text-negative"}`}>
                    {result ? `${totalReturn >= 0 ? "+" : ""}${formatNumber(totalReturn)}%` : "-"}
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="text-xs text-muted-foreground mb-1">승률</div>
                {isLoading ? <Skeleton className="h-7 w-24" /> : (
                  <div className="text-2xl font-bold font-mono">
                    {result ? `${formatNumber(result.metrics.winRatePercent)}%` : "-"}
                  </div>
                )}
                {result && (
                  <div className="text-xs text-muted-foreground mt-1">
                    {result.metrics.wins}승 / {result.metrics.losses}패
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="text-xs text-muted-foreground mb-1">최대 낙폭</div>
                {isLoading ? <Skeleton className="h-7 w-24" /> : (
                  <div className="text-2xl font-bold font-mono text-negative">
                    {result ? `-${formatNumber(result.metrics.maxDrawdownPercent)}%` : "-"}
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="text-xs text-muted-foreground mb-1">손익비 (PF)</div>
                {isLoading ? <Skeleton className="h-7 w-24" /> : (
                  <div className="text-2xl font-bold font-mono">
                    {result ? (Number.isFinite(result.metrics.profitFactor) ? formatNumber(result.metrics.profitFactor) : "∞") : "-"}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle>자본 곡선</CardTitle>
              <CardDescription>
                {result ? `${formatDate(result.startTime)} → ${formatDate(result.endTime)} · 시작 ${formatUsd(result.metrics.initialEquity)} → 종료 ${formatUsd(result.metrics.finalEquity)}` : "백테스트를 실행하세요"}
              </CardDescription>
            </CardHeader>
            <CardContent className="h-[320px]">
              {isLoading ? (
                <Skeleton className="w-full h-full" />
              ) : equityChart.length === 0 ? (
                <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                  결과가 여기에 표시됩니다
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={equityChart} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} minTickGap={40} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickFormatter={(v) => `$${(v as number).toFixed(0)}`} tickLine={false} axisLine={false} domain={["auto", "auto"]} />
                    <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))" }} formatter={(v: number) => [formatUsd(v), "자본"]} />
                    <ReferenceLine y={result?.metrics.initialEquity ?? 10000} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                    <Line type="monotone" dataKey="equity" stroke={isProfitable ? "hsl(var(--positive))" : "hsl(var(--negative))"} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {result && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center justify-between">
                  <span>거래 내역</span>
                  <Badge variant="secondary">{result.trades.length}건</Badge>
                </CardTitle>
                <CardDescription>
                  평균 익절 {formatUsd(result.metrics.avgWinUsd)} · 평균 손절 {formatUsd(result.metrics.avgLossUsd)} · Sharpe {formatNumber(result.metrics.sharpeRatio)}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {result.trades.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    <Activity className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    이 기간에는 다이버전스 신호가 없었습니다
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-xs text-muted-foreground border-b border-border">
                        <tr>
                          <th className="text-left py-2 px-2 font-medium">진입</th>
                          <th className="text-left py-2 px-2 font-medium">청산</th>
                          <th className="text-left py-2 px-2 font-medium">방향</th>
                          <th className="text-right py-2 px-2 font-medium">진입가</th>
                          <th className="text-right py-2 px-2 font-medium">청산가</th>
                          <th className="text-right py-2 px-2 font-medium">손익</th>
                          <th className="text-center py-2 px-2 font-medium">사유</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.trades.slice().reverse().map((t, i) => (
                          <tr key={i} className="border-b border-border/50 hover:bg-muted/30">
                            <td className="py-2 px-2 text-xs text-muted-foreground">{formatDate(t.entryTime)}</td>
                            <td className="py-2 px-2 text-xs text-muted-foreground">{formatDate(t.exitTime)}</td>
                            <td className="py-2 px-2">
                              <Badge variant="outline" className={t.side === "BUY" ? "border-positive text-positive" : "border-negative text-negative"}>
                                {t.side === "BUY" ? <TrendingUp className="h-3 w-3 mr-1 inline" /> : <TrendingDown className="h-3 w-3 mr-1 inline" />}
                                {t.side}
                              </Badge>
                            </td>
                            <td className="py-2 px-2 text-right font-mono text-xs">{formatUsd(t.entryPrice)}</td>
                            <td className="py-2 px-2 text-right font-mono text-xs">{formatUsd(t.exitPrice)}</td>
                            <td className={`py-2 px-2 text-right font-mono font-semibold ${t.pnlUsd >= 0 ? "text-positive" : "text-negative"}`}>
                              {t.pnlUsd >= 0 ? "+" : ""}{formatUsd(t.pnlUsd)}
                              <div className="text-xs font-normal opacity-70">
                                {t.pnlPercent >= 0 ? "+" : ""}{formatNumber(t.pnlPercent)}%
                              </div>
                            </td>
                            <td className="py-2 px-2 text-center">
                              <Badge variant="secondary" className="text-xs">
                                {t.exitReason === "tp" ? "익절" : t.exitReason === "sl" ? "손절" : "종료"}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
