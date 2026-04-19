import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";
import { useEffect, useState } from "react";
import NotFound from "@/pages/not-found";

import Dashboard from "@/pages/dashboard";
import Chart from "@/pages/chart";
import Portfolio from "@/pages/portfolio";
import BotControl from "@/pages/bot";
import Trade from "@/pages/trade";
import Backtest from "@/pages/backtest";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 5000,
    },
  },
});

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/chart" component={Chart} />
        <Route path="/portfolio" component={Portfolio} />
        <Route path="/bot" component={BotControl} />
        <Route path="/trade" component={Trade} />
        <Route path="/backtest" component={Backtest} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  return <>{children}</>;
}

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
