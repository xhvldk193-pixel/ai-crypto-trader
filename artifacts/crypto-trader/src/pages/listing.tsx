import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Rocket, Play, Square, RefreshCw, AlertTriangle, TrendingUp, TrendingDown, CheckCircle, Clock } from "lucide-react";

const API = "/api/listing";
async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`${API}${path}`, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export default function ListingPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [local, setLocal] = useState<Record<string, unknown>>({});

  const { data: status, isLoading } = useQuery({
    queryKey: ["listing-status"],
    queryFn: () => apiFetch("/status"),
    refetchInterval: 5000,
  });

  const { data: eventsData } = useQuery({
    queryKey: ["listing-events"],
    queryFn: () => apiFetch("/events?limit=30"),
    refetchInterval: 10000,
  });

  const start = useMutation({
    mutationFn: () => apiFetch("/start", { method: "POST" }),
    onSuccess: () => { toast({ title: "✅ 상장 모니터 시작" }); qc.invalidateQueries({ queryKey: ["listing-status"] }); },
    onError: (e: Error) => toast({ title: "오류", description: e.message, variant: "destructive" }),
  });
  const stop = useMutation({
    mutationFn: () => apiFetch("/stop", { method: "POST" }),
    onSuccess: () => { toast({ title: "⏹ 상장 모니터 정지" }); qc.invalidateQueries({ queryKey: ["listing-status"] }); },
  });
  const save = useMutation({
    mutationFn: (cfg: Record<string, unknown>) => apiFetch("/config", { method: "PUT", body: JSON.stringify(cfg) }),
    onSuccess: () => { toast({ title: "✅ 설정 저장됨" }); qc.invalidateQueries({ queryKey: ["listing-status"] }); setLocal({}); },
    onError: (e: Error) => toast({ title: "오류", description: e.message, variant: "destructive" }),
  });

  const cfg = { ...status?.config, ...local };
  const events = eventsData?.events ?? [];
  const totalPnl = events.filter((e: Record<string, unknown>) => e.pnl != null).reduce((s: number, e: Record<string, unknown>) => s + (e.pnl as number ?? 0), 0);
  const closed = events.filter((e: Record<string, unknown>) => e.status === "closed");
  const wins = closed.filter((e: Record<string, unknown>) => (e.pnl as number ?? 0) > 0);

  if (isLoading) return <div className="flex items-center justify-center h-64"><RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Rocket className="h-6 w-6 text-primary" />
          <h1 className="text-xl font-bold">상장 프론트런</h1>
        </div>
        {status?.monitorRunning
          ? <Button variant="destructive" size="sm" onClick={() => stop.mutate()} disabled={stop.isPending}><Square className="h-4 w-4 mr-1" />정지</Button>
          : <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending}><Play className="h-4 w-4 mr-1" />시작</Button>
        }
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "모니터", value: status?.monitorRunning ? "실행 중" : "정지됨" },
          { label: "활성 포지션", value: `${status?.activeTrades?.length ?? 0}개` },
          { label: "총 손익", value: `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`, color: totalPnl >= 0 ? "text-green-400" : "text-red-400" },
          { label: "승률", value: closed.length > 0 ? `${((wins.length / closed.length) * 100).toFixed(0)}%` : "-" },
        ].map(item => (
          <Card key={item.label}><CardContent className="pt-4 pb-3">
            <div className="text-xs text-muted-foreground mb-1">{item.label}</div>
            <div className={`font-bold text-lg ${item.color ?? ""}`}>{item.value}</div>
          </CardContent></Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">거래 설정</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <div className="text-sm font-medium">자동 거래 실행</div>
              <div className="text-xs text-muted-foreground">공지 감지 시 즉시 실거래 진입</div>
            </div>
            <Switch checked={cfg.enabled ?? false} onCheckedChange={v => setLocal(p => ({ ...p, enabled: v }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            {[
              { key: "tradeAmountUsdt", label: "거래금액 (USDT)", min: 1, step: 1 },
              { key: "leverage", label: "레버리지 (최대 10 권장)", min: 1, max: 10, step: 1 },
              { key: "takeProfitPercent", label: "목표수익 TP (%)", min: 1, step: 1 },
              { key: "stopLossPercent", label: "손절 SL (%)", min: 1, max: 50, step: 1 },
              { key: "maxHoldHours", label: "최대 보유 (시간)", min: 0.5, step: 0.5 },
              { key: "maxWaitSeconds", label: "비트겟 대기 (초)", min: 10, max: 300, step: 10 },
            ].map(f => (
              <div key={f.key} className="space-y-1">
                <label className="text-xs text-muted-foreground">{f.label}</label>
                <Input type="number" value={(cfg as Record<string, unknown>)[f.key] as number ?? 0}
                  onChange={e => setLocal(p => ({ ...p, [f.key]: Number(e.target.value) }))}
                  min={f.min} max={f.max} step={f.step} />
              </div>
            ))}
          </div>
          {Object.keys(local).length > 0 && (
            <Button className="w-full" onClick={() => save.mutate(local)} disabled={save.isPending}>
              {save.isPending ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : null}설정 저장
            </Button>
          )}
          <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/20 p-3 text-xs text-yellow-300 space-y-1">
            <div className="flex items-center gap-1 font-medium"><AlertTriangle className="h-3 w-3" />실거래 주의사항</div>
            <div>• 레버리지 2~3배 이하 강력 권장</div>
            <div>• 상장 직후 변동성 극단적으로 높음</div>
            <div>• 비트겟 미상장 코인은 자동 스킵</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">감지 이력</CardTitle></CardHeader>
        <CardContent>
          {events.length === 0
            ? <div className="text-center text-muted-foreground text-sm py-8">아직 감지된 상장 공지가 없습니다</div>
            : <div className="space-y-2">
              {events.map((e: Record<string, unknown>) => (
                <div key={e.id as number} className="rounded-lg border p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-sm">{e.symbol as string}</span>
                    <span className="text-xs text-muted-foreground">{new Date(e.detectedAt as string).toLocaleTimeString("ko-KR")}</span>
                  </div>
                  <div className="text-xs text-muted-foreground truncate">{e.title as string}</div>
                  {e.status === "closed" && e.pnl != null && (
                    <div className={`flex items-center gap-1 text-xs font-medium ${(e.pnl as number) >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {(e.pnl as number) >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                      {(e.pnl as number) >= 0 ? "+" : ""}${(e.pnl as number).toFixed(2)} ({(e.pnlPercent as number).toFixed(2)}%) — {e.exitReason as string}
                    </div>
                  )}
                  {e.status === "entered" && e.entryPrice && (
                    <div className="text-xs text-green-400 flex items-center gap-1">
                      <CheckCircle className="h-3 w-3" />진입 ${(e.entryPrice as number).toFixed(4)} → TP ${(e.takeProfit as number).toFixed(4)} / SL ${(e.stopLoss as number).toFixed(4)}
                    </div>
                  )}
                  {e.status === "skipped" && <div className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="h-3 w-3" />{e.note as string}</div>}
                </div>
              ))}
            </div>
          }
        </CardContent>
      </Card>
    </div>
  );
}
