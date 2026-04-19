import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useGetMarketSymbols, useGetMarketTicker, usePlaceOrder, useGetOpenOrders, useDeleteOrder, useGetPortfolioHistory } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { formatUsd, formatNumber, formatDate } from "@/lib/format";
import { Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

const orderSchema = z.object({
  symbol: z.string().min(1),
  type: z.enum(["market", "limit"]),
  quantity: z.coerce.number().positive(),
  price: z.coerce.number().positive().optional(),
});

type OrderFormValues = z.infer<typeof orderSchema>;

export default function Trade() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeSide, setActiveSide] = useState<"buy" | "sell">("buy");
  const [selectedSymbol, setSelectedSymbol] = useState("BTC/USDT");

  const { data: symbolsData } = useGetMarketSymbols();
  const symbols = symbolsData?.symbols || ["BTC/USDT"];

  const { data: ticker } = useGetMarketTicker(
    { symbol: selectedSymbol },
    { query: { refetchInterval: 2000 } as never }
  );

  const { data: openOrders } = useGetOpenOrders({ symbol: selectedSymbol });
  const { data: recentTrades } = useGetPortfolioHistory({ symbol: selectedSymbol, limit: 10 });

  const placeOrder = usePlaceOrder();
  const deleteOrder = useDeleteOrder();

  const form = useForm<OrderFormValues>({
    resolver: zodResolver(orderSchema),
    defaultValues: {
      symbol: "BTC/USDT",
      type: "market",
      quantity: 0.01,
    },
  });

  const orderType = form.watch("type");

  const onSubmit = (data: OrderFormValues) => {
    if (data.type === "limit" && !data.price) {
      form.setError("price", { type: "manual", message: "지정가 주문에는 가격이 필요합니다" });
      return;
    }

    placeOrder.mutate({ 
      data: { ...data, side: activeSide } 
    }, {
      onSuccess: () => {
        toast({ 
          title: "주문 완료", 
          description: `${activeSide === 'buy' ? '매수' : '매도'} 주문 ${data.quantity} ${data.symbol} 성공` 
        });
        queryClient.invalidateQueries({ queryKey: ["/api/portfolio/history"] });
        queryClient.invalidateQueries({ queryKey: ["/api/portfolio/positions"] });
        queryClient.invalidateQueries({ queryKey: ["/api/portfolio/balance"] });
        form.reset({ ...data, quantity: 0.01 });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "주문 실패";
        toast({ title: "주문 실패", description: msg, variant: "destructive" });
      }
    });
  };

  const handleCancelOrder = (orderId: string) => {
    deleteOrder.mutate({ orderId, params: { symbol: selectedSymbol } }, {
      onSuccess: () => {
        toast({ title: "주문 취소됨", description: `주문 ${orderId.substring(0,8)} 취소 완료.` });
      }
    });
  };

  const handleSymbolChange = (val: string) => {
    setSelectedSymbol(val);
    form.setValue("symbol", val);
  };

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">수동 거래</h1>

      <div className="grid gap-6 lg:grid-cols-12">
        <Card className="lg:col-span-4 h-fit">
          <CardHeader className="pb-4">
            <div className="flex justify-between items-end">
              <Select value={selectedSymbol} onValueChange={handleSymbolChange}>
                <SelectTrigger className="w-[140px] text-lg font-bold border-none bg-transparent px-0 h-auto focus:ring-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {symbols.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
              <div className="text-right">
                <div className="text-sm text-muted-foreground">시장가</div>
                <div className={`text-xl font-mono font-bold ${
                  ticker?.changePercent24h && ticker.changePercent24h >= 0 ? "text-positive" : "text-negative"
                }`}>
                  {formatUsd(ticker?.price)}
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Tabs value={activeSide} onValueChange={(v) => setActiveSide(v as "buy" | "sell")} className="w-full">
              <TabsList className="grid w-full grid-cols-2 mb-6">
                <TabsTrigger value="buy" className="data-[state=active]:bg-positive data-[state=active]:text-white">매수</TabsTrigger>
                <TabsTrigger value="sell" className="data-[state=active]:bg-negative data-[state=active]:text-white">매도</TabsTrigger>
              </TabsList>
              
              <TabsContent value={activeSide}>
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                    <FormField
                      control={form.control}
                      name="type"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>주문 유형</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="market">시장가</SelectItem>
                              <SelectItem value="limit">지정가</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {orderType === "limit" && (
                      <FormField
                        control={form.control}
                        name="price"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>지정가 (USD)</FormLabel>
                            <FormControl>
                              <Input type="number" step="0.01" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}

                    <FormField
                      control={form.control}
                      name="quantity"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>수량</FormLabel>
                          <FormControl>
                            <div className="relative">
                              <Input type="number" step="0.0001" {...field} />
                              <div className="absolute right-3 top-2 text-sm text-muted-foreground">
                                {selectedSymbol.split('/')[0]}
                              </div>
                            </div>
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {ticker && (
                      <div className="flex justify-between py-2 text-sm border-t border-border mt-4">
                        <span className="text-muted-foreground">예상 총액</span>
                        <span className="font-mono font-medium">
                          {formatUsd(
                            (orderType === "limit" && form.watch("price") ? Number(form.watch("price")) : ticker.price) * 
                            (Number(form.watch("quantity")) || 0)
                          )}
                        </span>
                      </div>
                    )}

                    <Button 
                      type="submit" 
                      className={`w-full py-6 text-lg font-bold ${activeSide === 'buy' ? 'bg-positive hover:bg-positive/90 text-white' : 'bg-negative hover:bg-negative/90 text-white'}`}
                      disabled={placeOrder.isPending || !ticker}
                    >
                      {placeOrder.isPending ? "처리 중..." : `${activeSide === 'buy' ? '매수' : '매도'} ${selectedSymbol.split('/')[0]}`}
                    </Button>
                  </form>
                </Form>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <div className="lg:col-span-8 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>미체결 주문</CardTitle>
            </CardHeader>
            <CardContent>
              {openOrders?.orders && openOrders.orders.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>시간</TableHead>
                      <TableHead>구분</TableHead>
                      <TableHead>유형</TableHead>
                      <TableHead>가격</TableHead>
                      <TableHead>수량</TableHead>
                      <TableHead>체결률</TableHead>
                      <TableHead className="text-right">취소</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {openOrders.orders.map((order) => (
                      <TableRow key={order.id}>
                        <TableCell className="text-muted-foreground">{formatDate(order.timestamp)}</TableCell>
                        <TableCell>
                          <span className={order.side === 'buy' ? 'text-positive font-bold' : 'text-negative font-bold'}>
                            {order.side === 'buy' ? '매수' : '매도'}
                          </span>
                        </TableCell>
                        <TableCell className="capitalize">{order.type === 'market' ? '시장가' : '지정가'}</TableCell>
                        <TableCell className="font-mono">{order.price ? formatUsd(order.price) : '시장가'}</TableCell>
                        <TableCell className="font-mono">{formatNumber(order.quantity, 4)}</TableCell>
                        <TableCell className="font-mono">{(order.filled / order.quantity * 100).toFixed(1)}%</TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="icon" className="text-destructive hover:bg-destructive/20" onClick={() => handleCancelOrder(order.id)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="text-center py-6 text-sm text-muted-foreground">미체결 주문 없음</div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>최근 거래 ({selectedSymbol})</CardTitle>
            </CardHeader>
            <CardContent>
              {recentTrades?.trades && recentTrades.trades.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>시간</TableHead>
                      <TableHead>구분</TableHead>
                      <TableHead>가격</TableHead>
                      <TableHead>수량</TableHead>
                      <TableHead className="text-right">총액</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentTrades.trades.map((trade) => (
                      <TableRow key={trade.id}>
                        <TableCell className="text-muted-foreground">{formatDate(trade.timestamp)}</TableCell>
                        <TableCell>
                          <span className={trade.side === 'buy' ? 'text-positive font-bold' : 'text-negative font-bold'}>
                            {trade.side === 'buy' ? '매수' : '매도'}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono">{formatUsd(trade.price)}</TableCell>
                        <TableCell className="font-mono">{formatNumber(trade.quantity, 4)}</TableCell>
                        <TableCell className="text-right font-mono">{formatUsd(trade.total)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="text-center py-6 text-sm text-muted-foreground">최근 거래 없음</div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
