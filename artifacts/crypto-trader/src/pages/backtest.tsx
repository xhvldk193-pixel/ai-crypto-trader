import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  useRunBacktest,
  useGetMarketSymbols,
  type BacktestResult,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Play, RefreshCw, TrendingUp, TrendingDown } from "lucide-react";
import { formatUsd, formatPercent, formatDate, formatNumber } from "@/lib/format";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ReferenceLine,
} from "recharts";

const schema = z.object({
  symbol: z.string().min(1),
  timeframe: z.enum(["15m", "1h", "4h", "1d"]),
  days: z.coerce.number().min(1).max(180),
  initialCapital: z.coerce.number().min(100),
  tradeAmount: z.coerce.number().min(10),
  minConfidence: z.coerce.number().min(0).max(1),
  useAtrTargets: z.boolean(),
  takeProfitPercent: z.coerce.number().min(0.1).max(50),
  stopLossPercent: z.coerce.number().min(0.1).max(50),
});

type FormValues = z.infer<typeof schema>;

export default function Backtest() {
  const { toast } = useToast();
  const { data: symbolsData } = useGetMarketSymbols();
  const symbols = symbolsData?.symbols || ["BTC/USDT"];
  const [result, setResult] = useState<BacktestResult | null>(null);

  const runMut = useRunBacktest();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      symbol: "BTC/USDT",
      timeframe: "15m",
      days: 30,
      initialCapital: 10000,
      tradeAmount: 1000,
      minConfidence: 0.6,
      useAtrTargets: true,
      takeProfitPercent: 2,
      stopLossPercent: 1,
    },
  });

  const useAtr = form.watch("useAtrTargets");

  const onSubmit = (data: FormValues) => {
    setResult(null);
    runMut.mutate(
      {
        data: {
          symbol: data.symbol,
          timeframe: data.timeframe,
          days: data.days,
          initialCapital: data.initialCapital,
          tradeAmount: data.tradeAmount,
          minConfidence: data.minConfidence,
          useAtrTargets: data.useAtrTargets,
          takeProfitPercent: data.useAtrTargets ? null : data.takeProfitPercent,
          stopLossPercent: data.useAtrTargets ? null : data.stopLossPercent,
          feePercent: 0.001,
        },
      },
      {
        onSuccess: (res) => {
          setResult(res);
          toast({
            title: "백테스트 완료",
            description: `${res.totalTrades}건 거래 / 승률 ${res.winRate.toFixed(1)}% / P&L ${res.totalPnlPercent >= 0 ? "+" : ""}${res.totalPnlPercent.toFixed(2)}%`,
          });
        },
        onError: (err: unknown) => {
          const msg = err instanceof Error ? err.message : "백테스트 실행에 실패했습니다.";
          toast({ title: "오류", description: msg, variant: "destructive" });
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">백테스트</h1>
        <p className="text-sm text-muted-foreground mt-1">
          과거 캔들 데이터로 다이버전스 + 결정론적 전략을 시뮬레이션해 성과를 검증합니다. (AI 호출 없음)
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-12">
        <Card className="lg:col-span-4">
          <CardHeader>
            <CardTitle>설정</CardTitle>
            <CardDescription>심볼과 기간을 선택해 시뮬레이션을 실행하세요.</CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="symbol"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>심볼</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {symbols.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="timeframe"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>타임프레임</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="15m">15분</SelectItem>
                            <SelectItem value="1h">1시간</SelectItem>
                            <SelectItem value="4h">4시간</SelectItem>
                            <SelectItem value="1d">1일</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="days"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>기간 (일)</FormLabel>
                      <FormControl><Input type="number" {...field} /></FormControl>
                      <FormDescription>최대 180일.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="initialCapital"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>초기 자본 (USD)</FormLabel>
                        <FormControl><Input type="number" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="tradeAmount"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>건당 거래액 (USD)</FormLabel>
                        <FormControl><Input type="number" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="minConfidence"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>최소 신뢰도 (0-1)</FormLabel>
                      <FormControl><Input type="number" step="0.05" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="useAtrTargets"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                      <div className="space-y-0.5">
                        <FormLabel className="text-base">ATR 기반 TP/SL</FormLabel>
                        <FormDescription>
                          켜면 변동성에 맞춰 자동, 끄면 아래 고정 % 사용.
                        </FormDescription>
                      </div>
                      <FormControl>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="takeProfitPercent"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>익절 (%)</FormLabel>
                        <FormControl><Input type="number" step="0.1" disabled={useAtr} {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="stopLossPercent"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>손절 (%)</FormLabel>
                        <FormControl><Input type="number" step="0.1" disabled={useAtr} {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <Button type="submit" className="w-full" disabled={runMut.isPending}>
                  {runMut.isPending ? (
                    <><RefreshCw className="mr-2 h-4 w-4 animate-spin" /> 실행 중...</>
                  ) : (
                    <><Play className="mr-2 h-4 w-4" /> 백테스트 실행</>
                  )}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>

        <div className="lg:col-span-8 space-y-6">
          {runMut.isPending ? (
            <Card>
              <CardContent className="py-12 space-y-3">
                <Skeleton className="h-8 w-1/2" />
                <Skeleton className="h-64 w-full" />
              </CardContent>
            </Card>
          ) : result ? (
            <ResultsView result={result} />
          ) : (
            <Card>
              <CardContent className="py-16 text-center text-muted-foreground">
                좌측에서 설정을 선택한 뒤 <span className="font-bold">백테스트 실행</span>을 눌러주세요.
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function ResultsView({ result }: { result: BacktestResult }) {
  const equityData = result.equityCurve.map((p) => ({
    t: p.timestamp,
    equity: p.equity,
  }));
  const positiveTotal = result.totalPnl >= 0;

  return (
    <>
      <div className="grid gap-4 md:grid-cols-4">
        <SummaryCard
          label="순손익"
          value={`${positiveTotal ? "+" : ""}${formatUsd(result.totalPnl)}`}
          sub={`${positiveTotal ? "+" : ""}${result.totalPnlPercent.toFixed(2)}%`}
          positive={positiveTotal}
        />
        <SummaryCard
          label="승률"
          value={`${result.winRate.toFixed(1)}%`}
          sub={`${result.winningTrades}W / ${result.losingTrades}L (총 ${result.totalTrades})`}
        />
        <SummaryCard
          label="최대 낙폭"
          value={`-${formatUsd(result.maxDrawdown)}`}
          sub={`-${result.maxDrawdownPercent.toFixed(2)}%`}
          positive={false}
        />
        <SummaryCard
          label="Profit Factor"
          value={
            result.profitFactor >= 999
              ? "∞"
              : result.profitFactor.toFixed(2)
          }
          sub={`평균 손익 ${formatUsd(result.avgPnl)}`}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>자본 곡선</CardTitle>
          <CardDescription>
            {formatDate(result.startTime)} – {formatDate(result.endTime)} · {result.candleCount} 캔들
          </CardDescription>
        </CardHeader>
        <CardContent className="h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={equityData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="t"
                stroke="hsl(var(--muted-foreground))"
                tickFormatter={(v) => formatDate(v as number).split(",")[0]}
                fontSize={11}
                minTickGap={40}
              />
              <YAxis
                stroke="hsl(var(--muted-foreground))"
                domain={["auto", "auto"]}
                tickFormatter={(v) => `$${formatNumber(v as number, 0)}`}
                fontSize={11}
                width={70}
              />
              <RechartsTooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  borderColor: "hsl(var(--border))",
                  fontSize: 12,
                }}
                labelFormatter={(v) => formatDate(v as number)}
                formatter={(v: number) => [formatUsd(v), "Equity"]}
              />
              <ReferenceLine
                y={result.initialCapital}
                stroke="hsl(var(--muted-foreground))"
                strokeDasharray="4 4"
                label={{ value: "초기자본", fill: "hsl(var(--muted-foreground))", fontSize: 10, position: "right" }}
              />
              <Line
                type="monotone"
                dataKey="equity"
                stroke={positiveTotal ? "hsl(152, 76%, 50%)" : "hsl(0, 76%, 60%)"}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>거래 내역</CardTitle>
          <CardDescription>
            평균 익절 {formatUsd(result.avgWin)} / 평균 손절 {formatUsd(result.avgLoss)} / 수수료 합계 {formatUsd(result.totalFees)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {result.trades.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground border border-dashed border-border rounded-lg">
              조건에 맞는 거래가 없습니다.
            </div>
          ) : (
            <div className="max-h-[480px] overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>진입</TableHead>
                    <TableHead>청산</TableHead>
                    <TableHead>방향</TableHead>
                    <TableHead>진입가</TableHead>
                    <TableHead>청산가</TableHead>
                    <TableHead>사유</TableHead>
                    <TableHead className="text-right">P&L</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.trades.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="text-muted-foreground text-xs">{formatDate(t.entryTime)}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">{formatDate(t.exitTime)}</TableCell>
                      <TableCell>
                        <Badge
                          className={t.side === "long" ? "bg-positive hover:bg-positive/90" : "bg-negative hover:bg-negative/90"}
                        >
                          {t.side === "long" ? <TrendingUp className="mr-1 h-3 w-3" /> : <TrendingDown className="mr-1 h-3 w-3" />}
                          {t.side.toUpperCase()}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono">{formatUsd(t.entryPrice)}</TableCell>
                      <TableCell className="font-mono">{formatUsd(t.exitPrice)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs uppercase">{t.exitReason}</Badge>
                      </TableCell>
                      <TableCell className={`text-right font-mono ${t.pnl >= 0 ? "text-positive" : "text-negative"}`}>
                        {t.pnl >= 0 ? "+" : ""}{formatUsd(t.pnl)}
                        <div className="text-xs text-muted-foreground">{formatPercent(t.pnlPercent)}</div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  positive,
}: {
  label: string;
  value: string;
  sub?: string;
  positive?: boolean;
}) {
  const colorClass = positive === undefined ? "" : positive ? "text-positive" : "text-negative";
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold font-mono ${colorClass}`}>{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-1 font-mono">{sub}</div>}
      </CardContent>
    </Card>
  );
}
