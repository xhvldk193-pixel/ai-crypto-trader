import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useGetBotStatus, useGetBotConfig, useUpdateBotConfig, useStartBot, useStopBot, useGetBotLogs, useGetMarketSymbols, useGetBotReflections, useSyncPositions } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Power, PowerOff, Activity, RefreshCw, Save, RotateCw } from "lucide-react";
import { formatDate } from "@/lib/format";

const overrideField = z
  .union([z.literal(""), z.coerce.number().positive()])
  .optional()
  .transform((v) => (v === "" || v === undefined ? null : v));

const symbolOverrideSchema = z.object({
  tradeAmount: overrideField,
  minConfidence: overrideField,
  takeProfitPercent: overrideField,
  stopLossPercent: overrideField,
});

const botConfigSchema = z.object({
  symbol: z.string().min(1),
  watchSymbols: z.array(z.string().min(1)).min(1, "최소 1개 이상의 페어를 선택하세요."),
  timeframe: z.string().min(1),
  tradeAmount: z.coerce.number().min(1),
  maxPositions: z.coerce.number().min(1).max(10),
  stopLossPercent: z.coerce.number().min(0.1).max(20),
  takeProfitPercent: z.coerce.number().min(0.1).max(50),
  minConfidence: z.coerce.number().min(0.1).max(0.99),
  autoTrade: z.boolean(),
  useAiTargets: z.boolean(),
  maxDailyLossPercent: z.coerce.number().min(0.5).max(50),
  useMtfFilter: z.boolean(),
  strictMtf: z.boolean(),
  mtfTimeframes: z.array(z.string().min(1)),
  useFundingRate: z.boolean(),
  symbolOverrides: z.record(z.string(), symbolOverrideSchema).default({}),
  leverage: z.coerce.number().int().min(1).max(125),
  marginType: z.enum(["ISOLATED", "CROSSED"]),
  notifyOnError: z.boolean(),
  useTrailingStop: z.boolean(),
  trailingActivatePercent: z.coerce.number().min(0.1).max(50),
  trailingDistancePercent: z.coerce.number().min(0.1).max(50),
  usePartialTp: z.boolean(),
  partialTpPercent: z.coerce.number().min(10).max(90),
  entryMode: z.enum(["fixed", "full"]),
  paperTrading: z.boolean(),
  checkIntervalSeconds: z.coerce.number().int().min(60),
  // 반대 신호 조기 청산
  useEarlyExitOnOpposite: z.boolean(),
  earlyExitOppositeCount: z.coerce.number().int().min(1).max(10),
  // 저변동성 TP 하향
  useLowVolTpReduction: z.boolean(),
  lowVolAtrThreshold: z.coerce.number().min(0.1).max(5.0),
  lowVolTpMultiplier: z.coerce.number().min(0.1).max(1.0),
});

const MTF_OPTIONS = ["1h", "4h", "1d"] as const;

type BotConfigFormValues = z.infer<typeof botConfigSchema>;

export default function BotControl() {
  const { toast } = useToast();
  const { data: symbolsData } = useGetMarketSymbols();
  const symbols = symbolsData?.symbols || ["BTC/USDT"];

  const { data: status, refetch: refetchStatus } = useGetBotStatus({ query: { refetchInterval: 5000 } as never });
  const { data: config, isLoading: isConfigLoading } = useGetBotConfig({
  query: { staleTime: 0, cacheTime: 0 } as never
});
  const { data: logsData } = useGetBotLogs({ limit: 20 }, { query: { refetchInterval: 5000 } as never });
  const { data: reflectionsData } = useGetBotReflections({ limit: 12 }, { query: { refetchInterval: 15000 } as never });

  const updateConfig = useUpdateBotConfig();
  const startBotMutation = useStartBot();
  const stopBotMutation = useStopBot();
  const syncPositionsMutation = useSyncPositions();

  const handleSyncPositions = () => {
    syncPositionsMutation.mutate(undefined, {
      onSuccess: (res) => {
        const r = res as unknown as { added: number; removed: number; details: string[] };
        toast({
          title: "동기화 완료",
          description: `추가 ${r.added}건 / 정리 ${r.removed}건${r.details.length ? "\n" + r.details.slice(0, 5).join("\n") : ""}`,
        });
      },
      onError: (err: unknown) => {
        toast({ title: "동기화 실패", description: err instanceof Error ? err.message : "오류", variant: "destructive" });
      },
    });
  };

  const form = useForm<BotConfigFormValues>({
    resolver: zodResolver(botConfigSchema),
    defaultValues: {
      symbol: "BTC/USDT",
      watchSymbols: ["BTC/USDT"],
      timeframe: "15m",
      tradeAmount: 100,
      maxPositions: 1,
      stopLossPercent: 2,
      takeProfitPercent: 5,
      minConfidence: 0.7,
      autoTrade: false,
      useAiTargets: true,
      maxDailyLossPercent: 3,
      useMtfFilter: true,
      strictMtf: true,
      mtfTimeframes: ["1h", "4h"],
      useFundingRate: true,
      symbolOverrides: {},
      leverage: 10,
      marginType: "ISOLATED",
      notifyOnError: true,
      useTrailingStop: false,
      trailingActivatePercent: 1.0,
      trailingDistancePercent: 0.5,
      usePartialTp: false,
      partialTpPercent: 50,
      entryMode: "fixed",
      paperTrading: true,
      checkIntervalSeconds: 900,
      useEarlyExitOnOpposite: false,
      earlyExitOppositeCount: 3,
      useLowVolTpReduction: false,
      lowVolAtrThreshold: 0.5,
      lowVolTpMultiplier: 0.6,
    },
  });

  const useAiTargetsValue = form.watch("useAiTargets");
  const useTrailingValue = form.watch("useTrailingStop");
  const usePartialValue = form.watch("usePartialTp");
  const entryModeValue = form.watch("entryMode");
  const useEarlyExitValue = form.watch("useEarlyExitOnOpposite");
  const useLowVolValue = form.watch("useLowVolTpReduction");

useEffect(() => {
  if (config) {
    const ws = config.watchSymbols && config.watchSymbols.length > 0 ? config.watchSymbols : [config.symbol];
    form.reset({
      symbol: config.symbol,
      watchSymbols: ws,
      timeframe: config.timeframe,
      tradeAmount: config.tradeAmount,
      maxPositions: config.maxPositions,
      stopLossPercent: config.stopLossPercent,
      takeProfitPercent: config.takeProfitPercent,
      minConfidence: config.minConfidence,
      autoTrade: config.autoTrade,
      useAiTargets: config.useAiTargets ?? true,
      maxDailyLossPercent: config.maxDailyLossPercent ?? 3,
      useMtfFilter: config.useMtfFilter ?? true,
      strictMtf: config.strictMtf ?? true,
      mtfTimeframes: config.mtfTimeframes && config.mtfTimeframes.length > 0 ? config.mtfTimeframes : ["1h", "4h"],
      useFundingRate: config.useFundingRate ?? true,
      symbolOverrides: (config.symbolOverrides as Record<string, { tradeAmount?: number | null; minConfidence?: number | null; takeProfitPercent?: number | null; stopLossPercent?: number | null }>) ?? {},
      leverage: config.leverage ?? 10,
      marginType: (config.marginType as "ISOLATED" | "CROSSED") ?? "ISOLATED",
      notifyOnError: config.notifyOnError ?? true,
      useTrailingStop: config.useTrailingStop ?? false,
      trailingActivatePercent: config.trailingActivatePercent ?? 1.0,
      trailingDistancePercent: config.trailingDistancePercent ?? 0.5,
      usePartialTp: config.usePartialTp ?? false,
      partialTpPercent: config.partialTpPercent ?? 50,
    entryMode: (config.entryMode === "full" ? "full" : "fixed") as "fixed" | "full",
      paperTrading: config.paperTrading ?? false,
      checkIntervalSeconds: config.checkIntervalSeconds ?? 900,
      useEarlyExitOnOpposite: (config as Record<string, unknown>).useEarlyExitOnOpposite as boolean ?? false,
      earlyExitOppositeCount: (config as Record<string, unknown>).earlyExitOppositeCount as number ?? 3,
      useLowVolTpReduction: (config as Record<string, unknown>).useLowVolTpReduction as boolean ?? false,
      lowVolAtrThreshold: (config as Record<string, unknown>).lowVolAtrThreshold as number ?? 0.5,
      lowVolTpMultiplier: (config as Record<string, unknown>).lowVolTpMultiplier as number ?? 0.6,
    });
  }
}, [config]);

  const onSubmit = (data: BotConfigFormValues) => {
    const payload = { ...data, symbol: data.watchSymbols[0] ?? data.symbol };
    const leverageOrMarginChanged =
      !!config && (data.leverage !== config.leverage || data.marginType !== config.marginType);
    updateConfig.mutate({ data: payload }, {
      onSuccess: () => {
        toast({
          title: "설정 저장됨",
          description: leverageOrMarginChanged
            ? "봇 설정이 업데이트되었습니다. 레버리지/마진모드 변경은 다음 신규 진입부터 적용됩니다."
            : "봇 설정이 업데이트되었습니다.",
        });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "설정 업데이트에 실패했습니다.";
        toast({ title: "오류", description: msg, variant: "destructive" });
      }
    });
  };

  const handleToggleBot = () => {
    if (status?.running) {
      stopBotMutation.mutate(undefined, {
        onSuccess: () => {
          toast({ title: "봇 중지됨", description: "트레이딩 봇이 중지되었습니다." });
          refetchStatus();
        }
      });
    } else {
      startBotMutation.mutate(undefined, {
        onSuccess: () => {
          toast({ title: "봇 시작됨", description: "트레이딩 봇이 활성화되어 시장을 모니터링합니다." });
          refetchStatus();
        }
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <h1 className="text-3xl font-bold tracking-tight">봇 제어</h1>
        
        <div className="flex items-center gap-4 flex-wrap">
          {status && (
            <div className={`flex items-center gap-2 px-3 py-2 rounded-md border ${
              status.halted ? 'border-destructive bg-destructive/10 text-destructive' :
              status.dailyPnlUsd >= 0 ? 'border-green-500/40 bg-green-500/10 text-green-500' :
              'border-yellow-500/40 bg-yellow-500/10 text-yellow-500'
            }`}>
              <span className="text-xs uppercase tracking-wider opacity-75">오늘 PnL</span>
              <span className="font-mono font-bold">
                {status.dailyPnlUsd >= 0 ? '+' : ''}${status.dailyPnlUsd.toFixed(2)} ({status.dailyPnlPercent >= 0 ? '+' : ''}{status.dailyPnlPercent.toFixed(2)}%)
              </span>
              {status.halted && <Badge variant="destructive" className="ml-1">손실 한도 도달</Badge>}
            </div>
          )}
          <div className={`flex items-center gap-2 px-4 py-2 rounded-md border ${
            status?.running ? 'border-primary bg-primary/10 text-primary' : 'border-muted bg-muted text-muted-foreground'
          }`}>
            {status?.running ? <Activity className="h-5 w-5 animate-pulse" /> : <PowerOff className="h-5 w-5" />}
            <span className="font-bold tracking-widest">{status?.running ? '실행 중' : '대기 중'}</span>
          </div>

          <Button
            size="lg"
            variant="outline"
            onClick={handleSyncPositions}
            disabled={syncPositionsMutation.isPending}
            title="거래소 실제 포지션과 DB를 동기화"
          >
            <RotateCw className={`mr-2 h-4 w-4 ${syncPositionsMutation.isPending ? "animate-spin" : ""}`} />
            포지션 동기화
          </Button>

          <Button
            size="lg"
            variant={status?.running ? "destructive" : "default"}
            onClick={handleToggleBot}
            disabled={startBotMutation.isPending || stopBotMutation.isPending}
          >
            {status?.running ? (
              <><PowerOff className="mr-2 h-4 w-4" /> 봇 중지</>
            ) : (
              <><Power className="mr-2 h-4 w-4" /> 봇 시작</>
            )}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-12">
        <Card className="lg:col-span-5">
          <CardHeader>
            <CardTitle>설정</CardTitle>
            <CardDescription>트레이딩 파라미터를 조정하세요. 변경 사항은 봇 재시작 후 완전히 적용됩니다.</CardDescription>
          </CardHeader>
          <CardContent>
            {isConfigLoading ? <Skeleton className="h-[400px] w-full" /> : (
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <FormField
                    control={form.control}
                    name="watchSymbols"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>감시 페어 (다중 선택)</FormLabel>
                        <FormDescription>
                          체크한 모든 페어에 대해 봇이 동시에 다이버전스를 분석하고 거래합니다.
                        </FormDescription>
                        <div className="flex flex-wrap gap-2 mt-1">
                          {field.value && field.value.length > 0 && field.value.map((s) => (
                            <Badge key={s} variant="secondary" className="font-mono">{s}</Badge>
                          ))}
                        </div>
                        <FormControl>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-48 overflow-y-auto rounded-md border p-3 mt-2">
                            {symbols.map((s) => {
                              const checked = field.value?.includes(s) ?? false;
                              return (
                                <label key={s} className="flex items-center gap-2 cursor-pointer hover:bg-muted/50 rounded px-1 py-1">
                                  <Checkbox
                                    checked={checked}
                                    onCheckedChange={(next) => {
                                      const current = field.value ?? [];
                                      if (next) {
                                        if (!current.includes(s)) field.onChange([...current, s]);
                                      } else {
                                        field.onChange(current.filter((x) => x !== s));
                                      }
                                    }}
                                  />
                                  <span className="text-xs font-mono">{s}</span>
                                </label>
                              );
                            })}
                          </div>
                        </FormControl>
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
                            <SelectTrigger>
                              <SelectValue placeholder="타임프레임 선택" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="15m">15분</SelectItem>
                            <SelectItem value="1h">1시간</SelectItem>
                            <SelectItem value="4h">4시간</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="paperTrading"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                        <div className="space-y-0.5">
                          <FormLabel>페이퍼 트레이딩 (가상 매매)</FormLabel>
                          <FormDescription>
                            ON: AI가 가상으로 매수·매도해서 학습합니다. 실거래소 주문 안 들어가고 자금도 사용 안 함.
                            OFF: 실제 Binance 선물 계좌에서 진짜 거래 실행.
                          </FormDescription>
                        </div>
                        <FormControl>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                      </FormItem>
                    )}
                  />

                  <FormField
  control={form.control}
  name="entryMode"
  render={({ field }) => (
    <FormItem>
      <FormLabel>진입 모드</FormLabel>
      <div className="flex gap-2">
        <Button
          type="button"
          variant={field.value === "fixed" ? "default" : "outline"}
          onClick={() => field.onChange("fixed")}
          className="flex-1"
        >
          고정 시드
        </Button>
        <Button
          type="button"
          variant={field.value === "full" ? "default" : "outline"}
          onClick={() => field.onChange("full")}
          className="flex-1"
        >
          풀 진입
        </Button>
      </div>
      <FormMessage />
    </FormItem>
  )}
/>

                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="tradeAmount"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            거래 금액 (USD){" "}
                            {entryModeValue === "full" && (
                              <span className="text-xs text-muted-foreground">(풀 진입 모드 — 무시됨)</span>
                            )}
                          </FormLabel>
                          <FormControl>
                            <Input type="number" disabled={entryModeValue === "full"} {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="maxPositions"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>최대 동시 포지션</FormLabel>
                          <FormControl>
                            <Input type="number" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="stopLossPercent"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>손절 (%) {useAiTargetsValue && <span className="text-xs text-muted-foreground">(AI 사용중)</span>}</FormLabel>
                          <FormControl>
                            <Input type="number" step="0.1" disabled={useAiTargetsValue} {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="takeProfitPercent"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>익절 (%) {useAiTargetsValue && <span className="text-xs text-muted-foreground">(AI 사용중)</span>}</FormLabel>
                          <FormControl>
                            <Input type="number" step="0.1" disabled={useAiTargetsValue} {...field} />
                          </FormControl>
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
                        <FormLabel>최소 AI 신뢰도 (0-1)</FormLabel>
                        <FormControl>
                          <Input type="number" step="0.05" {...field} />
                        </FormControl>
                        <FormDescription>거래를 트리거하는 임계값</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="useAiTargets"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm">
                        <div className="space-y-0.5">
                          <FormLabel className="text-base">AI 자동 익절/손절</FormLabel>
                          <FormDescription>
                            켜면 AI가 예측한 변동폭으로 TP/SL을 자동 설정합니다. 끄면 위의 고정 % 값이 사용됩니다.
                          </FormDescription>
                        </div>
                        <FormControl>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="maxDailyLossPercent"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>일일 최대 손실 한도 (%)</FormLabel>
                        <FormControl>
                          <Input type="number" step="0.1" {...field} />
                        </FormControl>
                        <FormDescription>오늘 누적 손실이 이 비율을 넘으면 자동으로 신규 진입을 중단합니다.</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="checkIntervalSeconds"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>체크 주기 (초)</FormLabel>
                        <FormControl>
                          <Input type="number" min={60} step={60} {...field} />
                        </FormControl>
                        <FormDescription>봇이 시장을 분석하는 주기. 15분봉 기준 권장값: 900초 (15분)</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="useMtfFilter"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm">
                        <div className="space-y-0.5">
                          <FormLabel className="text-base">MTF 필터 (멀티 타임프레임)</FormLabel>
                          <FormDescription>
                            상위 타임프레임 다이버전스 추세를 함께 분석해 진입 신뢰도를 높입니다.
                          </FormDescription>
                        </div>
                        <FormControl>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="mtfTimeframes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>MTF 타임프레임</FormLabel>
                        <FormControl>
                          <div className="flex flex-wrap gap-2">
                            {MTF_OPTIONS.map((tf) => {
                              const checked = field.value?.includes(tf) ?? false;
                              return (
                                <label key={tf} className="flex items-center gap-2 cursor-pointer rounded-md border px-3 py-1.5 hover:bg-muted/50">
                                  <Checkbox
                                    checked={checked}
                                    onCheckedChange={(next) => {
                                      const current = field.value ?? [];
                                      if (next) {
                                        if (!current.includes(tf)) field.onChange([...current, tf]);
                                      } else {
                                        field.onChange(current.filter((x) => x !== tf));
                                      }
                                    }}
                                  />
                                  <span className="text-xs font-mono">{tf}</span>
                                </label>
                              );
                            })}
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="strictMtf"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm">
                        <div className="space-y-0.5">
                          <FormLabel className="text-base">엄격 MTF 모드</FormLabel>
                          <FormDescription>
                            상위 TF가 반대 추세이면 AI 호출 없이 진입을 차단합니다.
                          </FormDescription>
                        </div>
                        <FormControl>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="useFundingRate"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm">
                        <div className="space-y-0.5">
                          <FormLabel className="text-base">선물 펀딩비 / 미결제약정 사용</FormLabel>
                          <FormDescription>
                            펀딩비와 OI 데이터를 AI 프롬프트에 포함해 시장 포지셔닝을 반영합니다.
                          </FormDescription>
                        </div>
                        <FormControl>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="symbolOverrides"
                    render={({ field }) => {
                      const watchList = form.watch("watchSymbols") ?? [];
                      const overrides = (field.value as Record<string, { tradeAmount?: number | null; minConfidence?: number | null; takeProfitPercent?: number | null; stopLossPercent?: number | null }>) ?? {};
                      const setField = (sym: string, key: string, raw: string) => {
                        const next = { ...overrides };
                        const entry = { ...(next[sym] ?? {}) };
                        if (raw === "") {
                          delete (entry as Record<string, unknown>)[key];
                        } else {
                          const n = Number(raw);
                          if (Number.isFinite(n)) (entry as Record<string, number>)[key] = n;
                        }
                        if (Object.keys(entry).length === 0) {
                          delete next[sym];
                        } else {
                          next[sym] = entry;
                        }
                        field.onChange(next);
                      };
                      return (
                        <FormItem className="rounded-lg border p-4 shadow-sm">
                          <FormLabel className="text-base">심볼별 파라미터 오버라이드</FormLabel>
                          <FormDescription>
                            각 페어마다 거래 금액·최소 신뢰도·TP/SL%를 덮어쓸 수 있습니다. 비워두면 위의 기본값을 사용합니다.
                          </FormDescription>
                          <div className="mt-3 space-y-3 max-h-72 overflow-y-auto">
                            {watchList.length === 0 && (
                              <div className="text-xs text-muted-foreground">먼저 감시 페어를 선택하세요.</div>
                            )}
                            {watchList.map((sym) => {
                              const o = overrides[sym] ?? {};
                              const valOf = (k: keyof typeof o) =>
                                o[k] === null || o[k] === undefined ? "" : String(o[k]);
                              return (
                                <div key={sym} className="rounded-md border bg-muted/30 p-3 space-y-2">
                                  <div className="flex items-center justify-between">
                                    <Badge variant="secondary" className="font-mono">{sym}</Badge>
                                    {Object.keys(o).length === 0 && (
                                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">기본값 사용</span>
                                    )}
                                  </div>
                                  <div className="grid grid-cols-2 gap-2">
                                    <label className="text-xs space-y-1">
                                      <span className="text-muted-foreground">거래 금액 (USD)</span>
                                      <Input
                                        type="number"
                                        step="1"
                                        placeholder="기본값"
                                        value={valOf("tradeAmount")}
                                        onChange={(e) => setField(sym, "tradeAmount", e.target.value)}
                                      />
                                    </label>
                                    <label className="text-xs space-y-1">
                                      <span className="text-muted-foreground">최소 신뢰도 (0–1)</span>
                                      <Input
                                        type="number"
                                        step="0.05"
                                        placeholder="기본값"
                                        value={valOf("minConfidence")}
                                        onChange={(e) => setField(sym, "minConfidence", e.target.value)}
                                      />
                                    </label>
                                    <label className="text-xs space-y-1">
                                      <span className="text-muted-foreground">익절 (%)</span>
                                      <Input
                                        type="number"
                                        step="0.1"
                                        placeholder="기본값"
                                        value={valOf("takeProfitPercent")}
                                        onChange={(e) => setField(sym, "takeProfitPercent", e.target.value)}
                                      />
                                    </label>
                                    <label className="text-xs space-y-1">
                                      <span className="text-muted-foreground">손절 (%)</span>
                                      <Input
                                        type="number"
                                        step="0.1"
                                        placeholder="기본값"
                                        value={valOf("stopLossPercent")}
                                        onChange={(e) => setField(sym, "stopLossPercent", e.target.value)}
                                      />
                                    </label>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          <FormMessage />
                        </FormItem>
                      );
                    }}
                  />

                  <div className="rounded-lg border p-4 shadow-sm space-y-3">
                    <div className="text-sm font-semibold">선물 거래 설정</div>
                    <div className="grid grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="leverage"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>레버리지: {field.value}x</FormLabel>
                            <FormControl>
                              <div className="space-y-2 pt-2">
                                <Slider
                                  min={1}
                                  max={125}
                                  step={1}
                                  value={[Number(field.value) || 10]}
                                  onValueChange={(v: number[]) => field.onChange(v[0])}
                                />
                                <div className="flex justify-between text-[10px] text-muted-foreground">
                                  <span>1x</span><span>25x</span><span>50x</span><span>75x</span><span>125x</span>
                                </div>
                              </div>
                            </FormControl>
                            <FormDescription className="text-xs">1–125배 슬라이더로 조절 (기본 10x)</FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="marginType"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>마진 모드</FormLabel>
                            <Select onValueChange={field.onChange} value={field.value}>
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="ISOLATED">격리 (ISOLATED)</SelectItem>
                                <SelectItem value="CROSSED">교차 (CROSSED)</SelectItem>
                              </SelectContent>
                            </Select>
                            <FormDescription className="text-xs">격리: 포지션별 마진 분리 (권장)</FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  </div>

                  <FormField
                    control={form.control}
                    name="notifyOnError"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm">
                        <div className="space-y-0.5">
                          <FormLabel className="text-base">텔레그램 오류 알림</FormLabel>
                          <FormDescription>
                            진입/청산/부분익절 실패 또는 봇 틱 오류를 텔레그램으로 즉시 알립니다 (5분 내 동일 오류 중복 차단).
                          </FormDescription>
                        </div>
                        <FormControl>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                      </FormItem>
                    )}
                  />

                  <div className="rounded-lg border p-4 shadow-sm space-y-3">
                    <FormField
                      control={form.control}
                      name="useTrailingStop"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-center justify-between">
                          <div className="space-y-0.5">
                            <FormLabel className="text-base">트레일링 스톱</FormLabel>
                            <FormDescription>
                              진입 후 일정 이익 도달 시 손절선이 가격을 따라 끌어올려져 수익을 보호합니다.
                            </FormDescription>
                          </div>
                          <FormControl>
                            <Switch checked={field.value} onCheckedChange={field.onChange} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    {useTrailingValue && (
                      <div className="grid grid-cols-2 gap-4">
                        <FormField
                          control={form.control}
                          name="trailingActivatePercent"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs">활성화 임계값 (%)</FormLabel>
                              <FormControl>
                                <Input type="number" step="0.1" {...field} />
                              </FormControl>
                              <FormDescription className="text-xs">진입가 대비 이익 % (예: 1 = 1% 수익 시 활성)</FormDescription>
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="trailingDistancePercent"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs">트레일링 거리 (%)</FormLabel>
                              <FormControl>
                                <Input type="number" step="0.1" {...field} />
                              </FormControl>
                              <FormDescription className="text-xs">최고가에서 후행할 거리 % (예: 0.5)</FormDescription>
                            </FormItem>
                          )}
                        />
                      </div>
                    )}
                  </div>

                  <div className="rounded-lg border p-4 shadow-sm space-y-3">
                    <FormField
                      control={form.control}
                      name="usePartialTp"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-center justify-between">
                          <div className="space-y-0.5">
                            <FormLabel className="text-base">부분 익절</FormLabel>
                            <FormDescription>
                              가격이 1차 TP에 도달하면 일부 수량을 청산하고 SL을 본전으로 이동합니다. 잔여 수량은 2차 TP(원거리×2) 또는 SL에서 청산됩니다.
                            </FormDescription>
                          </div>
                          <FormControl>
                            <Switch checked={field.value} onCheckedChange={field.onChange} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    {usePartialValue && (
                      <FormField
                        control={form.control}
                        name="partialTpPercent"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">청산 비율 (%)</FormLabel>
                            <FormControl>
                              <Input type="number" step="5" {...field} />
                            </FormControl>
                            <FormDescription className="text-xs">중간 도달 시 청산할 비율 (10–90%, 기본 50%)</FormDescription>
                          </FormItem>
                        )}
                      />
                    )}
                  </div>

                  {/* ── 반대 신호 조기 청산 ── */}
                  <div className="space-y-3 rounded-lg border p-4">
                    <FormField
                      control={form.control}
                      name="useEarlyExitOnOpposite"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-center justify-between">
                          <div className="space-y-0.5">
                            <FormLabel className="text-base">반대 신호 조기 청산</FormLabel>
                            <FormDescription>
                              보유 중 반대 방향 다이버전스가 설정 개수 이상 발생하면 즉시 청산합니다.
                            </FormDescription>
                          </div>
                          <FormControl>
                            <Switch checked={field.value} onCheckedChange={field.onChange} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    {useEarlyExitValue && (
                      <FormField
                        control={form.control}
                        name="earlyExitOppositeCount"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">반대 신호 임계값 (개)</FormLabel>
                            <FormControl>
                              <Input type="number" min={1} max={10} step={1} {...field} />
                            </FormControl>
                            <FormDescription className="text-xs">반대 방향 다이버전스가 이 값 이상이면 청산 (기본 3개)</FormDescription>
                          </FormItem>
                        )}
                      />
                    )}
                  </div>

                  {/* ── 저변동성 TP 하향 조정 ── */}
                  <div className="space-y-3 rounded-lg border p-4">
                    <FormField
                      control={form.control}
                      name="useLowVolTpReduction"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-center justify-between">
                          <div className="space-y-0.5">
                            <FormLabel className="text-base">저변동성 목표 수익률 하향</FormLabel>
                            <FormDescription>
                              ATR%가 임계값 미만인 낮은 변동성 환경에서 목표 수익(TP)을 자동으로 줄입니다.
                            </FormDescription>
                          </div>
                          <FormControl>
                            <Switch checked={field.value} onCheckedChange={field.onChange} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    {useLowVolValue && (
                      <div className="space-y-3 pl-1">
                        <FormField
                          control={form.control}
                          name="lowVolAtrThreshold"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs">ATR% 임계값</FormLabel>
                              <FormControl>
                                <Input type="number" min={0.1} max={5} step={0.1} {...field} />
                              </FormControl>
                              <FormDescription className="text-xs">이 값 미만의 ATR%를 저변동성으로 판단 (기본 0.5%)</FormDescription>
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="lowVolTpMultiplier"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs">TP 축소 비율 (0.1 ~ 1.0)</FormLabel>
                              <FormControl>
                                <Input type="number" min={0.1} max={1.0} step={0.05} {...field} />
                              </FormControl>
                              <FormDescription className="text-xs">TP를 원래의 이 비율만큼 축소 (기본 0.6 = 60%)</FormDescription>
                            </FormItem>
                          )}
                        />
                      </div>
                    )}
                  </div>

                  <FormField
                    control={form.control}
                    name="autoTrade"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm">
                        <div className="space-y-0.5">
                          <FormLabel className="text-base font-bold text-primary">자동 거래 실행</FormLabel>
                          <FormDescription>
                            활성화 시 봇이 실제 주문을 실행합니다.
                          </FormDescription>
                        </div>
                        <FormControl>
                          <Switch
                            checked={field.value}
                            onCheckedChange={field.onChange}
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />

                  <Button type="submit" className="w-full" disabled={updateConfig.isPending}>
                    {updateConfig.isPending ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    설정 저장
                  </Button>
                </form>
              </Form>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-7 flex flex-col">
          <CardHeader>
            <CardTitle>활동 로그</CardTitle>
            <CardDescription>봇 분석 및 실행 현황 실시간 피드.</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 min-h-0 relative">
            <div className="absolute inset-4 overflow-y-auto bg-black border border-border rounded-md p-4 font-mono text-xs shadow-inner">
              {!logsData?.logs || logsData.logs.length === 0 ? (
                <div className="text-muted-foreground text-center mt-10">활동 대기 중...</div>
              ) : (
                <div className="space-y-1.5">
                  {logsData.logs.map((log) => (
                    <div key={log.id} className="flex hover:bg-white/5 px-1 py-0.5 rounded">
                      <span className="text-gray-500 w-[140px] shrink-0">[{formatDate(log.timestamp)}]</span>
                      <span className={`w-[80px] shrink-0 ${
                        log.level === 'error' ? 'text-red-500 font-bold' : 
                        log.level === 'warning' ? 'text-yellow-500' : 
                        log.level === 'trade' ? 'text-green-400 font-bold' : 'text-blue-400'
                      }`}>[{log.level.toUpperCase()}]</span>
                      {log.symbol && <span className="text-purple-400 w-[80px] shrink-0">{log.symbol}</span>}
                      {log.action && <span className={`w-[60px] shrink-0 ${log.action === 'BUY' ? 'text-green-500' : log.action === 'SELL' ? 'text-red-500' : ''}`}>{log.action}</span>}
                      <span className="text-gray-300 whitespace-pre-wrap">{log.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>AI 자가 학습 — 최근 거래 복기 노트</CardTitle>
          <CardDescription>
            TP/SL 청산이 일어날 때마다 Claude가 결과를 복기하여 핵심 교훈을 작성하고, 이 노트들은 다음 매매 판단의 컨텍스트로 자동 주입됩니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!reflectionsData?.reflections || reflectionsData.reflections.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">
              아직 복기 데이터가 없습니다. 첫 TP/SL 청산이 일어나면 여기에 표시됩니다.
            </div>
          ) : (
            <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1">
              {reflectionsData.reflections.map((r) => {
                const isWin = r.exitReason === "TP";
                const pnlColor = r.pnlPercent >= 0 ? "text-green-500" : "text-red-500";
                const holdMin = Math.floor(r.holdSeconds / 60);
                return (
                  <div key={r.id} className="border border-border rounded-md p-3 bg-card/50">
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <Badge variant={isWin ? "default" : "destructive"} className={isWin ? "bg-green-600 hover:bg-green-700" : ""}>
                        {isWin ? "✓ 익절 (TP)" : r.exitReason === "SL" ? "✗ 손절! (SL)" : r.exitReason}
                      </Badge>
                      <Badge variant="outline">{r.symbol}</Badge>
                      <Badge variant="outline" className="uppercase">{r.side}</Badge>
                      <span className={`font-mono text-sm font-bold ${pnlColor}`}>
                        {r.pnlPercent >= 0 ? "+" : ""}{r.pnlPercent.toFixed(2)}%
                      </span>
                      <span className="text-xs text-muted-foreground font-mono">
                        ${r.entryPrice.toFixed(4)} → ${r.exitPrice.toFixed(4)}
                      </span>
                      <span className="text-xs text-muted-foreground">보유 {holdMin}분</span>
                      <span className="text-xs text-muted-foreground">
                        강세 {r.bullishCount} / 약세 {r.bearishCount}
                      </span>
                      {typeof r.originalConfidence === "number" && (
                        <span className="text-xs text-muted-foreground">
                          진입 신뢰도 {(r.originalConfidence * 100).toFixed(0)}%
                        </span>
                      )}
                      <span className="ml-auto text-xs text-muted-foreground">{formatDate(r.timestamp)}</span>
                    </div>
                    {r.lessonText ? (
                      <p className="text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap">
                        💡 {r.lessonText}
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">복기 노트 생성 중...</p>
                    )}
                    {r.originalReasoning && (
                      <details className="mt-2 text-xs text-muted-foreground">
                        <summary className="cursor-pointer hover:text-foreground">진입 당시 AI 근거 보기</summary>
                        <p className="mt-1 pl-2 border-l-2 border-border whitespace-pre-wrap">{r.originalReasoning}</p>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
// force rebuild