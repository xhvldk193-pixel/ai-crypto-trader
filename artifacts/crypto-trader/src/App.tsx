import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";
import { useEffect } from "react";
import NotFound from "@/pages/not-found";

import Dashboard from "@/pages/dashboard";
import Chart from "@/pages/chart";
import Portfolio from "@/pages/portfolio";
import BotControl from "@/pages/bot";
import Trade from "@/pages/trade";
import Backtest from "@/pages/backtest";
import Listing from "@/pages/listing";          // ✅ 추가
import LoginPage from "@/pages/login";
import { useGetAuthStatus, getGetAuthStatusQueryKey } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 5000,
      retry: (failureCount, error: unknown) => {
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (status === 401 || status === 429) return false;
        return failureCount < 2;
      },
    },
  },
});

queryClient.getQueryCache().subscribe((event) => {
  const error = event?.query?.state?.error as { response?: { status?: number } } | undefined;
  if (error?.response?.status === 401) {
    queryClient.setQueryData(getGetAuthStatusQueryKey(), { authed: false, loggedInAt: null });
  }
});
queryClient.getMutationCache().subscribe((event) => {
  const error = event?.mutation?.state?.error as { response?: { status?: number } } | undefined;
  if (error?.response?.status === 401) {
    queryClient.setQueryData(getGetAuthStatusQueryKey(), { authed: false, loggedInAt: null });
  }
});

function AuthGate({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useGetAuthStatus({
    query: { refetchInterval: 60_000, retry: false } as never,
  });

  useEffect(() => {
    if (data?.authed === false) {
      qc.removeQueries({ predicate: (q) => {
        const key = q.queryKey[0];
        return typeof key === "string" && !key.includes("/auth/");
      }});
    }
  }, [data?.authed, qc]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <div className="w-full max-w-md space-y-3">
          <Skeleton className="h-8 w-1/2 mx-auto" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (isError || !data?.authed) return <LoginPage />;
  return <>{children}</>;
}

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
        <Route path="/listing" component={Listing} />   {/* ✅ 추가 */}
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => { document.documentElement.classList.add("dark"); }, []);
  return <>{children}</>;
}

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <AuthGate>
              <Router />
            </AuthGate>
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
