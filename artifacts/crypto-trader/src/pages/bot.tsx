import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useGetBotStatus, useGetBotConfig, useUpdateBotConfig, useStartBot, useStopBot, useGetBotLogs, useGetMarketSymbols } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Power, PowerOff, Activity, RefreshCw, Save } from "lucide-react";
import { formatDate } from "@/lib/format";

const botConfigSchema = z.object({
  symbol: z.string().min(1),
  timeframe: z.string().min(1),
  tradeAmount: z.coerce.number().min(1),
  maxPositions: z.coerce.number().min(1).max(10),
  stopLossPercent: z.coerce.number().min(0.1).max(20),
  takeProfitPercent: z.coerce.number().min(0.1).max(50),
  minConfidence: z.coerce.number().min(0.1).max(0.99),
  autoTrade: z.boolean(),
  useAiTargets: z.boolean(),
});

type BotConfigFormValues = z.infer<typeof botConfigSchema>;

export default function BotControl() {
  const { toast } = useToast();
  const { data: symbolsData } = useGetMarketSymbols();
  const symbols = symbolsData?.symbols || ["BTC/USDT"];

  const { data: status, refetch: refetchStatus } = useGetBotStatus({ query: { refetchInterval: 5000 } as never });
  const { data: config, isLoading: isConfigLoading } = useGetBotConfig();
  const { data: logsData } = useGetBotLogs({ limit: 20 }, { query: { refetchInterval: 5000 } as never });

  const updateConfig = useUpdateBotConfig();
  const startBotMutation = useStartBot();
  const stopBotMutation = useStopBot();

  const form = useForm<BotConfigFormValues>({
    resolver: zodResolver(botConfigSchema),
    defaultValues: {
      symbol: "BTC/USDT",
      timeframe: "15m",
      tradeAmount: 100,
      maxPositions: 1,
      stopLossPercent: 2,
      takeProfitPercent: 5,
      minConfidence: 0.7,
      autoTrade: false,
      useAiTargets: true,
    },
  });

  const useAiTargetsValue = form.watch("useAiTargets");

  useEffect(() => {
    if (config) {
      form.reset({
        symbol: config.symbol,
        timeframe: config.timeframe,
        tradeAmount: config.tradeAmount,
        maxPositions: config.maxPositions,
        stopLossPercent: config.stopLossPercent,
        takeProfitPercent: config.takeProfitPercent,
        minConfidence: config.minConfidence,
        autoTrade: config.autoTrade,
        useAiTargets: config.useAiTargets ?? true,
      });
    }
  }, [config, form]);

  const onSubmit = (data: BotConfigFormValues) => {
    updateConfig.mutate({ data }, {
      onSuccess: () => {
        toast({ title: "설정 저장됨", description: "봇 설정이 업데이트되었습니다." });
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
        
        <div className="flex items-center gap-4">
          <div className={`flex items-center gap-2 px-4 py-2 rounded-md border ${
            status?.running ? 'border-primary bg-primary/10 text-primary' : 'border-muted bg-muted text-muted-foreground'
          }`}>
            {status?.running ? <Activity className="h-5 w-5 animate-pulse" /> : <PowerOff className="h-5 w-5" />}
            <span className="font-bold tracking-widest">{status?.running ? '실행 중' : '대기 중'}</span>
          </div>
          
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
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="symbol"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>거래 페어</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="페어 선택" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {symbols.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
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
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="tradeAmount"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>거래 금액 (USD)</FormLabel>
                          <FormControl>
                            <Input type="number" {...field} />
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
    </div>
  );
}
