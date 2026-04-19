import { useState, useMemo } from "react";
import { useGetMarketOhlcv, useGetMarketSymbols, useAnalyzeDivergence, useGetAiSignal, useGetMarketTicker, useGetActivePositions } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatUsd, formatNumber } from "@/lib/format";
import { ComposedChart, Area, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { Brain, TrendingUp, TrendingDown, Activity } from "lucide-react";

function formatChartTime(ts: number, timeframe: string) {
  const date = new Date(ts);
  if (timeframe === '1d') return date.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
  return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export default function Chart() {
  const [symbol, setSymbol] = useState("BTC/USDT");
  const [timeframe, setTimeframe] = useState<"15m" | "1h" | "4h" | "1d">("15m");

  const { data: symbolsData } = useGetMarketSymbols();
  const symbols = symbolsData?.symbols || ["BTC/USDT", "ETH/USDT", "SOL/USDT"];

  const { data: ticker } = useGetMarketTicker(
    { symbol },
    { query: { refetchInterval: 5000 } as never }
  );

  const { data: ohlcvData, isLoading: isOhlcvLoading } = useGetMarketOhlcv(
    { symbol, timeframe, limit: 100 },
    { query: { refetchInterval: 60000 } as never }
  );

  const { data: divergenceData, isLoading: isDivergenceLoading } = useAnalyzeDivergence(
    { symbol, timeframe },
    { query: { refetchInterval: 60000 } as never }
  );

  const { data: activeData } = useGetActivePositions({ query: { refetchInterval: 5000 } as never });
  const symbolPositions = useMemo(
    () => (activeData?.positions ?? []).filter((p) => p.symbol === symbol),
    [activeData, symbol]
  );

  const getAiSignal = useGetAiSignal();
  const [aiSignalResult, setAiSignalResult] = useState<Record<string, unknown> | null>(null);
  const [isAiLoading, setIsAiLoading] = useState(false);

  const handleAnalyze = () => {
    if (!ticker) return;
    setIsAiLoading(true);
    getAiSignal.mutate(
      { data: { symbol, timeframe, currentPrice: ticker.price, divergenceData, change24h: ticker.changePercent24h } },
      {
        onSuccess: (data) => {
          setAiSignalResult(data as unknown as Record<string, unknown>);
          setIsAiLoading(false);
        },
        onError: () => {
          setIsAiLoading(false);
        }
      }
    );
  };

  const chartData = useMemo(() => {
    if (!ohlcvData?.candles) return [];
    return ohlcvData.candles.map(c => ({
      ...c,
      formattedTime: formatChartTime(c.timestamp, timeframe),
    }));
  }, [ohlcvData, timeframe]);

  const aiEntry = aiSignalResult?.suggestedEntryPrice as number | undefined;
  const aiTp = aiSignalResult?.suggestedTakeProfit as number | undefined;
  const aiSl = aiSignalResult?.suggestedStopLoss as number | undefined;
  const overlayPrices = useMemo(() => {
    const prices: number[] = [];
    for (const p of symbolPositions) {
      prices.push(p.entryPrice, p.takeProfit, p.stopLoss);
    }
    if (Number.isFinite(aiEntry)) prices.push(aiEntry as number);
    if (Number.isFinite(aiTp)) prices.push(aiTp as number);
    if (Number.isFinite(aiSl)) prices.push(aiSl as number);
    return prices;
  }, [symbolPositions, aiEntry, aiTp, aiSl]);

  const minPrice = chartData.length > 0
    ? Math.min(...chartData.map(d => d.low), ...overlayPrices) * 0.99
    : 0;
  const maxPrice = chartData.length > 0
    ? Math.max(...chartData.map(d => d.high), ...overlayPrices) * 1.01
    : 0;

  const action = aiSignalResult?.action as string | undefined;
  const confidence = aiSignalResult?.confidence as number | undefined;
  const riskLevel = aiSignalResult?.riskLevel as string | undefined;
  const suggestedEntryPrice = aiEntry;
  const suggestedStopLoss = aiSl;
  const suggestedTakeProfit = aiTp;
  const reasoning = aiSignalResult?.reasoning as string | undefined;

  return (
    <div className="space-y-6 h-full flex flex-col">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <h1 className="text-3xl font-bold tracking-tight">시장 차트</h1>
        
        <div className="flex items-center gap-2">
          <Select value={symbol} onValueChange={setSymbol}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="심볼" />
            </SelectTrigger>
            <SelectContent>
              {symbols.map(s => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={timeframe} onValueChange={(v) => setTimeframe(v as "15m" | "1h" | "4h" | "1d")}>
            <SelectTrigger className="w-[100px]">
              <SelectValue placeholder="타임프레임" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="15m">15분</SelectItem>
              <SelectItem value="1h">1시간</SelectItem>
              <SelectItem value="4h">4시간</SelectItem>
              <SelectItem value="1d">1일</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-4 flex-1">
        <div className="lg:col-span-3 space-y-4 flex flex-col">
          <Card className="flex-1 min-h-[400px] flex flex-col">
            <CardHeader className="pb-2">
              <div className="flex justify-between items-center">
                <div>
                  <CardTitle>{symbol}</CardTitle>
                  <CardDescription>가격 & 거래량 ({timeframe})</CardDescription>
                </div>
                {ticker && (
                  <div className="text-right">
                    <div className="text-xl font-bold font-mono">{formatUsd(ticker.price)}</div>
                    <div className={`text-sm ${ticker.changePercent24h >= 0 ? "text-positive" : "text-negative"}`}>
                      {ticker.changePercent24h >= 0 ? "+" : ""}{formatNumber(ticker.changePercent24h)}%
                    </div>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="flex-1 min-h-0">
              {isOhlcvLoading ? (
                <div className="w-full h-full flex items-center justify-center">
                  <Skeleton className="w-full h-full" />
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis 
                      dataKey="formattedTime" 
                      stroke="hsl(var(--muted-foreground))" 
                      fontSize={12} 
                      tickLine={false} 
                      axisLine={false}
                    />
                    <YAxis 
                      yAxisId="price"
                      domain={[minPrice, maxPrice]} 
                      stroke="hsl(var(--muted-foreground))" 
                      fontSize={12} 
                      tickFormatter={(v) => `$${v.toLocaleString()}`}
                      tickLine={false} 
                      axisLine={false}
                      orientation="right"
                    />
                    <YAxis 
                      yAxisId="volume"
                      orientation="left"
                      stroke="hsl(var(--muted-foreground))" 
                      fontSize={12} 
                      tickLine={false} 
                      axisLine={false}
                      hide
                    />
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }}
                      itemStyle={{ color: 'hsl(var(--foreground))' }}
                      labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
                    />
                    <Area 
                      yAxisId="price"
                      type="monotone" 
                      dataKey="close" 
                      stroke="hsl(var(--primary))" 
                      fillOpacity={1} 
                      fill="url(#colorPrice)" 
                      strokeWidth={2}
                    />
                    <Bar 
                      yAxisId="volume"
                      dataKey="volume" 
                      fill="hsl(var(--muted))" 
                      opacity={0.5} 
                      barSize={4}
                    />
                    {symbolPositions.map((p) => (
                      <ReferenceLine
                        key={`entry-${p.id}`}
                        yAxisId="price"
                        y={p.entryPrice}
                        stroke="hsl(var(--muted-foreground))"
                        strokeDasharray="4 4"
                        label={{ value: `진입 ${formatUsd(p.entryPrice)}`, position: "insideRight", fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                      />
                    ))}
                    {symbolPositions.map((p) => (
                      <ReferenceLine
                        key={`tp-${p.id}`}
                        yAxisId="price"
                        y={p.takeProfit}
                        stroke="hsl(var(--positive))"
                        strokeDasharray="4 4"
                        label={{ value: `TP ${formatUsd(p.takeProfit)}`, position: "insideRight", fill: "hsl(var(--positive))", fontSize: 11 }}
                      />
                    ))}
                    {symbolPositions.map((p) => (
                      <ReferenceLine
                        key={`sl-${p.id}`}
                        yAxisId="price"
                        y={p.stopLoss}
                        stroke="hsl(var(--negative))"
                        strokeDasharray="4 4"
                        label={{ value: `SL ${formatUsd(p.stopLoss)}`, position: "insideRight", fill: "hsl(var(--negative))", fontSize: 11 }}
                      />
                    ))}
                    {Number.isFinite(aiEntry) && symbolPositions.length === 0 && (
                      <ReferenceLine yAxisId="price" y={aiEntry as number} stroke="hsl(var(--muted-foreground))" strokeDasharray="2 6" label={{ value: `AI 진입 ${formatUsd(aiEntry as number)}`, position: "insideRight", fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
                    )}
                    {Number.isFinite(aiTp) && symbolPositions.length === 0 && (
                      <ReferenceLine yAxisId="price" y={aiTp as number} stroke="hsl(var(--positive))" strokeDasharray="2 6" label={{ value: `AI TP ${formatUsd(aiTp as number)}`, position: "insideRight", fill: "hsl(var(--positive))", fontSize: 10 }} />
                    )}
                    {Number.isFinite(aiSl) && symbolPositions.length === 0 && (
                      <ReferenceLine yAxisId="price" y={aiSl as number} stroke="hsl(var(--negative))" strokeDasharray="2 6" label={{ value: `AI SL ${formatUsd(aiSl as number)}`, position: "insideRight", fill: "hsl(var(--negative))", fontSize: 10 }} />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">다이버전스 신호</CardTitle>
            </CardHeader>
            <CardContent>
              {isDivergenceLoading ? <Skeleton className="h-20 w-full" /> : divergenceData && divergenceData.signals.length > 0 ? (
                <div className="space-y-2">
                  <div className="flex gap-2 mb-2">
                    <Badge variant="outline" className="border-positive text-positive">
                      강세: {divergenceData.bullishCount}
                    </Badge>
                    <Badge variant="outline" className="border-negative text-negative">
                      약세: {divergenceData.bearishCount}
                    </Badge>
                    <Badge variant="secondary">
                      편향: {divergenceData.overallBias === 'bullish' ? '강세' : divergenceData.overallBias === 'bearish' ? '약세' : '중립'}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {divergenceData.signals.map((sig, i) => (
                      <div key={i} className="flex items-start gap-2 p-2 rounded bg-muted/50 border border-border text-sm">
                        {sig.type.includes('positive') ? (
                          <TrendingUp className="h-4 w-4 text-positive mt-0.5 shrink-0" />
                        ) : (
                          <TrendingDown className="h-4 w-4 text-negative mt-0.5 shrink-0" />
                        )}
                        <div>
                          <div className="font-semibold">{sig.indicator.toUpperCase()} - {sig.type.replace('_', ' ')}</div>
                          <div className="text-xs text-muted-foreground">{sig.description}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-center text-sm text-muted-foreground py-4">
                  이 타임프레임에서 다이버전스가 감지되지 않았습니다.
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Brain className="h-5 w-5 text-primary" />
                AI 분석
              </CardTitle>
              <CardDescription>
                다이버전스와 가격 움직임을 기반으로 실시간 AI 트레이딩 신호를 받으세요.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button 
                className="w-full" 
                onClick={handleAnalyze} 
                disabled={isAiLoading || !ticker}
              >
                {isAiLoading ? "분석 중..." : "시장 분석"}
              </Button>

              {aiSignalResult && (
                <div className="pt-4 border-t border-border space-y-4">
                  <div className="text-center">
                    <div className={`text-4xl font-bold tracking-tighter ${
                      action === 'BUY' ? 'text-positive' : 
                      action === 'SELL' ? 'text-negative' : 'text-foreground'
                    }`}>
                      {action === 'BUY' ? '매수' : action === 'SELL' ? '매도' : '관망'}
                    </div>
                  </div>

                  {confidence !== undefined && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span>신뢰도</span>
                        <span>{(confidence * 100).toFixed(0)}%</span>
                      </div>
                      <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
                        <div 
                          className={`h-full ${
                            action === 'BUY' ? 'bg-positive' : 
                            action === 'SELL' ? 'bg-negative' : 'bg-primary'
                          }`}
                          style={{ width: `${confidence * 100}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="space-y-2 text-sm">
                    {riskLevel && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">리스크 수준</span>
                        <span className={`font-medium ${
                          riskLevel === 'high' ? 'text-negative' :
                          riskLevel === 'medium' ? 'text-warning' : 'text-positive'
                        }`}>{riskLevel === 'high' ? '높음' : riskLevel === 'medium' ? '중간' : '낮음'}</span>
                      </div>
                    )}
                    
                    {suggestedEntryPrice && (
                      <div className="flex justify-between font-mono">
                        <span className="text-muted-foreground">진입가</span>
                        <span>{formatUsd(suggestedEntryPrice)}</span>
                      </div>
                    )}
                    {suggestedStopLoss && (
                      <div className="flex justify-between font-mono">
                        <span className="text-muted-foreground">손절가</span>
                        <span className="text-negative">{formatUsd(suggestedStopLoss)}</span>
                      </div>
                    )}
                    {suggestedTakeProfit && (
                      <div className="flex justify-between font-mono">
                        <span className="text-muted-foreground">익절가</span>
                        <span className="text-positive">{formatUsd(suggestedTakeProfit)}</span>
                      </div>
                    )}
                  </div>

                  {reasoning && (
                    <div className="text-sm bg-muted/50 p-3 rounded border border-border">
                      <p className="font-semibold mb-1 flex items-center gap-1">
                        <Activity className="h-3 w-3" /> 분석 근거
                      </p>
                      <p className="text-muted-foreground leading-relaxed">{reasoning}</p>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
