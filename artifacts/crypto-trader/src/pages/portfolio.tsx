import { useGetPortfolioBalance, useGetPortfolioPositions, useGetPortfolioHistory, useGetPortfolioSummary } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { formatUsd, formatPercent, formatDate, formatNumber } from "@/lib/format";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";

export default function Portfolio() {
  const { data: balance, isLoading: isBalanceLoading } = useGetPortfolioBalance();
  const { data: positionsData, isLoading: isPositionsLoading } = useGetPortfolioPositions();
  const { data: historyData, isLoading: isHistoryLoading } = useGetPortfolioHistory({ limit: 50 });
  const { data: summary, isLoading: isSummaryLoading } = useGetPortfolioSummary();

  const pieData = balance?.balances.filter(b => b.usdValue > 1).map(b => ({
    name: b.asset,
    value: b.usdValue
  })) || [];
  
  const COLORS = ['hsl(152, 76%, 36%)', 'hsl(217, 91%, 60%)', 'hsl(35, 100%, 55%)', 'hsl(280, 65%, 60%)', 'hsl(0, 0%, 50%)'];

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Portfolio</h1>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Value</CardTitle>
          </CardHeader>
          <CardContent>
            {isBalanceLoading ? <Skeleton className="h-8 w-32" /> : (
              <div className="text-3xl font-bold font-mono">{formatUsd(balance?.totalUsd)}</div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">All-Time P&L</CardTitle>
          </CardHeader>
          <CardContent>
            {isSummaryLoading ? <Skeleton className="h-8 w-32" /> : (
              <div className="flex items-end gap-2">
                <div className={`text-3xl font-bold font-mono ${summary && summary.totalPnl >= 0 ? "text-positive" : "text-negative"}`}>
                  {summary && summary.totalPnl >= 0 ? "+" : ""}{formatUsd(summary?.totalPnl)}
                </div>
                <div className={`text-sm mb-1 font-mono ${summary && summary.totalPnlPercent >= 0 ? "text-positive" : "text-negative"}`}>
                  ({summary && summary.totalPnlPercent >= 0 ? "+" : ""}{formatPercent(summary?.totalPnlPercent)})
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Win Rate</CardTitle>
          </CardHeader>
          <CardContent>
            {isSummaryLoading ? <Skeleton className="h-8 w-32" /> : (
              <div className="flex items-end gap-2">
                <div className="text-3xl font-bold font-mono">{formatPercent(summary?.winRate)}</div>
                <div className="text-sm mb-1 text-muted-foreground">
                  {summary?.profitableTrades} / {summary?.totalTrades} Trades
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Open Positions</CardTitle>
          </CardHeader>
          <CardContent>
            {isPositionsLoading ? <Skeleton className="h-40 w-full" /> : positionsData?.positions && positionsData.positions.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Symbol</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Entry Price</TableHead>
                    <TableHead>Current Price</TableHead>
                    <TableHead className="text-right">P&L</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {positionsData.positions.map((pos, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-medium">{pos.symbol}</TableCell>
                      <TableCell>
                        <Badge variant={pos.side === 'long' ? 'default' : 'destructive'} className={pos.side === 'long' ? 'bg-positive hover:bg-positive/90' : 'bg-negative hover:bg-negative/90'}>
                          {pos.side.toUpperCase()}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono">{formatNumber(pos.quantity, 4)}</TableCell>
                      <TableCell className="font-mono">{formatUsd(pos.entryPrice)}</TableCell>
                      <TableCell className="font-mono">{formatUsd(pos.currentPrice)}</TableCell>
                      <TableCell className={`text-right font-mono ${pos.pnl >= 0 ? "text-positive" : "text-negative"}`}>
                        {pos.pnl >= 0 ? "+" : ""}{formatUsd(pos.pnl)} ({formatPercent(pos.pnlPercent)})
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="text-center py-8 text-muted-foreground border border-dashed border-border rounded-lg">
                No open positions
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Asset Allocation</CardTitle>
          </CardHeader>
          <CardContent className="flex justify-center items-center h-[300px]">
             {isBalanceLoading ? <Skeleton className="h-[200px] w-[200px] rounded-full" /> : pieData.length > 0 ? (
               <ResponsiveContainer width="100%" height="100%">
                 <PieChart>
                   <Pie
                     data={pieData}
                     cx="50%"
                     cy="50%"
                     innerRadius={60}
                     outerRadius={80}
                     paddingAngle={5}
                     dataKey="value"
                     stroke="none"
                   >
                     {pieData.map((entry, index) => (
                       <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                     ))}
                   </Pie>
                   <RechartsTooltip 
                     formatter={(value: number) => formatUsd(value)}
                     contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }}
                     itemStyle={{ color: 'hsl(var(--foreground))' }}
                   />
                 </PieChart>
               </ResponsiveContainer>
             ) : (
               <div className="text-muted-foreground text-sm">No assets</div>
             )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Trade History</CardTitle>
        </CardHeader>
        <CardContent>
          {isHistoryLoading ? <Skeleton className="h-64 w-full" /> : historyData?.trades && historyData.trades.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Symbol</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Quantity</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead className="text-right">P&L</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {historyData.trades.map((trade) => (
                  <TableRow key={trade.id}>
                    <TableCell className="text-muted-foreground">{formatDate(trade.timestamp)}</TableCell>
                    <TableCell className="font-medium">{trade.symbol}</TableCell>
                    <TableCell>
                      <span className={trade.side === 'buy' ? 'text-positive font-bold' : 'text-negative font-bold'}>
                        {trade.side.toUpperCase()}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {trade.triggeredBy.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono">{formatUsd(trade.price)}</TableCell>
                    <TableCell className="font-mono">{formatNumber(trade.quantity, 4)}</TableCell>
                    <TableCell className="font-mono">{formatUsd(trade.total)}</TableCell>
                    <TableCell className="text-right font-mono">
                      {trade.pnl !== undefined ? (
                        <span className={trade.pnl >= 0 ? "text-positive" : "text-negative"}>
                          {trade.pnl >= 0 ? "+" : ""}{formatUsd(trade.pnl)}
                        </span>
                      ) : "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8 text-muted-foreground border border-dashed border-border rounded-lg">
              No trade history
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
