import { useState } from "react";
import { useLogin } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Lock, Shield } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetAuthStatusQueryKey } from "@workspace/api-client-react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const login = useLogin();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const result = await login.mutateAsync({ data: { password } });
      if (result.authed) {
        await queryClient.invalidateQueries({ queryKey: getGetAuthStatusQueryKey() });
        setPassword("");
      } else {
        setError("비밀번호가 올바르지 않습니다.");
      }
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 429) {
        setError("로그인 시도가 너무 많습니다. 15분 후 다시 시도하세요.");
      } else if (status === 401) {
        setError("비밀번호가 올바르지 않습니다.");
      } else {
        setError("로그인에 실패했습니다. 잠시 후 다시 시도하세요.");
      }
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center space-y-2">
          <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Shield className="w-6 h-6 text-primary" />
          </div>
          <CardTitle className="text-2xl">소유자 인증</CardTitle>
          <CardDescription>
            이 트레이딩 봇은 소유자만 접근할 수 있습니다.
            <br />
            설정한 비밀번호를 입력하세요.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">비밀번호</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  id="password"
                  type="password"
                  autoFocus
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="pl-9"
                  disabled={login.isPending}
                />
              </div>
            </div>
            {error && (
              <div className="text-sm text-red-500 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
                {error}
              </div>
            )}
            <Button type="submit" className="w-full" disabled={login.isPending || !password}>
              {login.isPending ? "확인 중..." : "로그인"}
            </Button>
            <p className="text-xs text-muted-foreground text-center">
              브루트포스 방지를 위해 15분간 최대 10회까지 시도할 수 있습니다.
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
