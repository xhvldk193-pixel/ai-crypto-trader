import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Rocket, Play, Square, RefreshCw, AlertTriangle, CheckCircle, Clock, TrendingUp, TrendingDown } from "lucide-react";

const API = "/api/listing";

async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

interface ListingStatus {
  monitorRunning: boolean;
  config: {
    enabled: boolean;
    tradeAmountUsdt: number;
    takeProfitPercent: number;
    stopLossPercent: number;
    maxHoldHours: number;
    leverage: number;
    maxWaitSeconds: number;
  };
  activeTrades: Array<{
    symbol: string;
    entryPrice: number;
    takeProfit: number;
    stopLoss: number;
    entryTime: number;
    maxHoldMs: number;
    announcementTitle: string;
  }>;
}

interface ListingEvent {
  id: number;
  symbol: string;
  sourceExchange: string;
  title: string;
  detectedAt: string;
  status: string;
  entryPrice: number | null;
  takeProfit: number | null;
  stopLoss: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  pnl: number | null;
  pnlPercent: number | null;
  note: string | null;
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    detected:   { label: "감지됨",   className: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
    processing: { label: "처리 중",  className: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" },
    entered:    { label: "보유 중",  className: "bg-green-500/20 text-green-400 border-green-500/30" },
    closed:     { label: "청산됨",   className: "bg-gray-500/20 text-gray-400 border-gray-500/30" },
    skipped:    { label: "스킵",     className: "bg-gray-500/20 text-gray-400 border-gray-500/30" },
    failed:     { label: "실패",     className: "bg-red-500/20 text-red-400 border-red-500/30" },
  };
  const s = map[status] ?? { label: status, className: "" };
  return <span className={`text-xs px-2 py-0.5 rounded-full border ${s.className}`}>{s.label}</span>;
}

export default function ListingPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [localConfig, setLocalConfig] = useState<Partial<ListingStatus["config"]>>({});

  const { data: status, isLoading } = useQuery<ListingStatus>({
    queryKey: ["listing-status"],
    queryFn: () => apiFetch("/status"),
    refetchInterval: 5000,
  });

  const { data: eventsData } = useQuery<{ events: ListingEvent[] }>({
    queryKey: ["listing-events"],
    queryFn: () => apiFetch("/events?limit=30"),
    refetchInterval: 10000,
  });

  const startMonitor = useMutation({
    mutationFn: () => apiFetch("/start", { method: "POST" }),
    onSuccess: () => {
      toast({ title: "✅ 상장 모니터 시작됨", description: "10초마다 바이낸스 공지 폴링 중" });
      qc.invalidateQueries({ queryKey: ["listing-status"] });
    },
    onError: (e: Error) => toast({ title: "오류", description: e.message, variant: "destructive" }),
  });

  const stopMonitor = useMutation({
    mutationFn: () => apiFetch("/stop", { method: "POST" }),
    onSuccess: () => {
      toast({ title: "⏹ 상장 모니터 정지됨" });
      qc.invalidateQueries({ queryKey: ["listing-status"] });
    },
  });

  const saveConfig = useMutation({
    mutationFn: (cfg: typeof localConfig) =>
      apiFetch("/config", { method: "PUT", body: JSON.stringify(cfg) }),
    onSuccess: () => {
      toast({ title: "✅ 설정 저장됨" });
      qc.invalidateQueries({ queryKey: ["listing-status"] });
      setLocalConfig({});
    },
    onError: (e: Error) => toast({ title: "오류", description: e.message, variant: "destructive" }),
  });

  const cfg = { ...status?.config, ...localConfig };
  const isDirty = Object.keys(localConfig).length > 0;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const events = eventsData?.events ?? [];
  const totalPnl = events.filter(e => e.pnl != null).reduce((s, e) => s + (e.pnl ?? 0), 0);
  const closedTrades = events.filter(e => e.status === "closed");
  const winTrades = closedTrades.filter(e => (e.pnl ?? 0) > 0);

  return (
    <div className="space-y-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Rocket className="h-6 w-6 text-primary" />
          <h1 className="text-xl font-bold">상장 프론트런</h1>
          <span className="text-xs text-muted-foreground">바이낸스 공지 → 비트겟 선매수</span>
        </div>
        <div className="flex items-center gap-2">
          {status?.monitorRunning ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => stopMonitor.mutate()}
              disabled={stopMonitor.isPending}
            >
              <Square className="h-4 w-4 mr-1" />
              정지
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => startMonitor.mutate()}
              disabled={startMonitor.isPending}
            >
              <Play className="h-4 w-4 mr-1" />
              시작
            </Button>
          )}
        </div>
      </div>

      {/* 상태 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-xs text-muted-foreground mb-1">모니터 상태</div>
            <div className="flex items-center gap-2">
              <span className={`relative flex h-2 w-2`}>
                {status?.monitorRunning && (
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                )}
                <span className={`relative inline-flex rounded-full h-2 w-2 ${status?.monitorRunning ? "bg-primary" : "bg-muted-foreground"}`} />
              </span>
              <span className="font-semibold text-sm">
                {status?.monitorRunning ? "실행 중" : "정지됨"}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-xs text-muted-foreground mb-1">활성 포지션</div>
            <div className="font-bold text-lg">{status?.activeTrades?.length ?? 0}개</div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-xs text-muted-foreground mb-1">총 손익</div>
            <div className={`font-bold text-lg ${totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
              {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-xs text-muted-foreground mb-1">승률</div>
            <div className="font-bold text-lg">
              {closedTrades.length > 0
                ? `${((winTrades.length / closedTrades.length) * 100).toFixed(0)}%`
                : "-"}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 활성 포지션 */}
      {(status?.activeTrades?.length ?? 0) > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
              </span>
              보유 중인 포지션
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {status?.activeTrades?.map(trade => {
              const holdMin = Math.floor((Date.now() - trade.entryTime) / 60_000);
              const maxMin = Math.floor(trade.maxHoldMs / 60_000);
              return (
                <div key={trade.symbol} className="rounded-lg border border-green-500/20 bg-green-500/5 p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-sm">{trade.symbol}</span>
                    <span className="text-xs text-muted-foreground">{holdMin}/{maxMin}분</span>
                  </div>
                  <div className="text-xs text-muted-foreground truncate">{trade.announcementTitle}</div>
                  <div className="grid grid-cols-3 gap-2 text-xs mt-1">
                    <div>
                      <span className="text-muted-foreground">진입 </span>
                      <span>${trade.entryPrice.toFixed(4)}</span>
                    </div>
                    <div>
                      <span className="text-green-400">TP </span>
                      <span>${trade.takeProfit.toFixed(4)}</span>
                    </div>
                    <div>
                      <span className="text-red-400">SL </span>
                      <span>${trade.stopLoss.toFixed(4)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* 설정 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">거래 설정</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 활성화 토글 */}
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <div className="text-sm font-medium">자동 거래 실행</div>
              <div className="text-xs text-muted-foreground">공지 감지 시 즉시 실거래 진입</div>
            </div>
            <Switch
              checked={cfg.enabled ?? false}
              onCheckedChange={v => setLocalConfig(prev => ({ ...prev, enabled: v }))}
            />
          </div>

          {/* 숫자 설정들 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">거래금액 (USDT)</label>
              <Input
                type="number"
                value={cfg.tradeAmountUsdt ?? 100}
                onChange={e => setLocalConfig(prev => ({ ...prev, tradeAmountUsdt: Number(e.target.value) }))}
                min={1}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">레버리지 (최대 10배 권장)</label>
              <Input
                type="number"
                value={cfg.leverage ?? 2}
                onChange={e => setLocalConfig(prev => ({ ...prev, leverage: Number(e.target.value) }))}
                min={1}
                max={10}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">목표 수익 TP (%)</label>
              <Input
                type="number"
                value={cfg.takeProfitPercent ?? 30}
                onChange={e => setLocalConfig(prev => ({ ...prev, takeProfitPercent: Number(e.target.value) }))}
                min={1}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">손절 SL (%)</label>
              <Input
                type="number"
                value={cfg.stopLossPercent ?? 10}
                onChange={e => setLocalConfig(prev => ({ ...prev, stopLossPercent: Number(e.target.value) }))}
                min={1}
                max={50}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">최대 보유 (시간)</label>
              <Input
                type="number"
                value={cfg.maxHoldHours ?? 4}
                onChange={e => setLocalConfig(prev => ({ ...prev, maxHoldHours: Number(e.target.value) }))}
                min={0.5}
                max={72}
                step={0.5}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">비트겟 대기 (초)</label>
              <Input
                type="number"
                value={cfg.maxWaitSeconds ?? 60}
                onChange={e => setLocalConfig(prev => ({ ...prev, maxWaitSeconds: Number(e.target.value) }))}
                min={10}
                max={300}
              />
            </div>
          </div>

          {isDirty && (
            <Button
              className="w-full"
              onClick={() => saveConfig.mutate(localConfig)}
              disabled={saveConfig.isPending}
            >
              {saveConfig.isPending
                ? <RefreshCw className="h-4 w-4 animate-spin mr-2" />
                : null}
              설정 저장
            </Button>
          )}

          <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/20 p-3 text-xs text-yellow-300 space-y-1">
            <div className="flex items-center gap-1 font-medium">
              <AlertTriangle className="h-3 w-3" />
              실거래 주의사항
            </div>
            <div>• 레버리지는 2~3배 이하 강력 권장</div>
            <div>• 상장 직후 변동성이 극단적으로 높음</div>
            <div>• 비트겟 미상장 코인이면 자동 스킵됨</div>
            <div>• 모니터 시작 전 자동 거래 실행 ON 확인</div>
          </div>
        </CardContent>
      </Card>

      {/* 이벤트 이력 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">감지 이력</CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <div className="text-center text-muted-foreground text-sm py-8">
              아직 감지된 상장 공지가 없습니다
            </div>
          ) : (
            <div className="space-y-2">
              {events.map(event => (
                <div key={event.id} className="rounded-lg border p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm">{event.symbol}</span>
                      <StatusBadge status={event.status} />
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {new Date(event.detectedAt).toLocaleTimeString("ko-KR")}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground truncate">{event.title}</div>

                  {event.status === "closed" && event.pnl != null && (
                    <div className={`flex items-center gap-1 text-xs font-medium ${event.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {event.pnl >= 0
                        ? <TrendingUp className="h-3 w-3" />
                        : <TrendingDown className="h-3 w-3" />}
                      {event.pnl >= 0 ? "+" : ""}${event.pnl.toFixed(2)}
                      ({event.pnl >= 0 ? "+" : ""}{event.pnlPercent?.toFixed(2)}%)
                      — {event.exitReason}
                    </div>
                  )}

                  {event.status === "entered" && event.entryPrice && (
                    <div className="text-xs text-green-400 flex items-center gap-1">
                      <CheckCircle className="h-3 w-3" />
                      진입가 ${event.entryPrice.toFixed(4)}
                      → TP ${event.takeProfit?.toFixed(4)} / SL ${event.stopLoss?.toFixed(4)}
                    </div>
                  )}

                  {event.status === "skipped" && event.note && (
                    <div className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {event.note}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
