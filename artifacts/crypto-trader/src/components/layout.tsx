import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Activity, LayoutDashboard, LineChart, PieChart, Settings, ArrowLeftRight, History, LogOut, Rocket } from "lucide-react";
import { useGetBotStatus, useLogout, getGetAuthStatusQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { data: botStatus } = useGetBotStatus();
  const logout = useLogout();
  const qc = useQueryClient();

  const handleLogout = async () => {
    try {
      await logout.mutateAsync();
    } catch {
      // ignore — fall through to clearing client state
    }
    qc.setQueryData(getGetAuthStatusQueryKey(), { authed: false, loggedInAt: null });
    qc.clear();
  };

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/chart", label: "Chart", icon: LineChart },
    { href: "/portfolio", label: "Portfolio", icon: PieChart },
    { href: "/bot", label: "Bot Control", icon: Settings },
    { href: "/trade", label: "Trade", icon: ArrowLeftRight },
    { href: "/backtest", label: "Backtest", icon: History },
    { href: "/listing", label: "상장 프론트런", icon: Rocket },
  ];

  return (
    <div className="flex h-screen w-full flex-col md:flex-row overflow-hidden bg-background text-foreground">
      {/* Sidebar */}
      <div className="flex w-full md:w-64 flex-col border-b md:border-b-0 md:border-r border-border bg-card">
        <div className="flex h-14 items-center px-4 border-b border-border">
          <Activity className="h-6 w-6 text-primary mr-2" />
          <span className="font-bold text-lg font-mono tracking-tight">AI TRADER</span>
          {botStatus && (
            <div className="ml-auto flex items-center gap-2 text-xs font-mono">
              <span className="relative flex h-2 w-2">
                {botStatus.running && (
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                )}
                <span className={`relative inline-flex rounded-full h-2 w-2 ${botStatus.running ? 'bg-primary' : 'bg-muted-foreground'}`}></span>
              </span>
              <span className="text-muted-foreground">{botStatus.running ? 'BOT: ON' : 'BOT: OFF'}</span>
            </div>
          )}
        </div>
        <nav className="flex-1 overflow-y-auto py-4">
          <ul className="grid gap-1 px-2">
            {navItems.map((item) => {
              const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    }`}
                  >
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="border-t border-border p-2">
          <button
            type="button"
            onClick={handleLogout}
            disabled={logout.isPending}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
          >
            <LogOut className="h-4 w-4" />
            로그아웃
          </button>
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto bg-background">
        <div className="p-4 md:p-6 h-full w-full max-w-7xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
