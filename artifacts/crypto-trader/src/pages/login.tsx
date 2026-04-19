import { useEffect, useState } from "react";
import {
  useLogin,
  useVerifyTwoFactor,
  getGetAuthStatusQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Lock, Shield, Send, ArrowLeft } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

type Step = "password" | "twoFactor";

export default function LoginPage() {
  const [step, setStep] = useState<Step>("password");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const login = useLogin();
  const verify = useVerifyTwoFactor();

  // Reset code field when entering 2FA step
  useEffect(() => {
    if (step === "twoFactor") {
      setCode("");
    }
  }, [step]);

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    try {
      const result = await login.mutateAsync({ data: { password } });
      if (result.needs2fa) {
        setStep("twoFactor");
        setInfo("텔레그램으로 6자리 인증 코드를 보냈습니다. 5분 안에 입력하세요.");
        setPassword("");
      } else if (result.authed) {
        // Server may bypass 2FA in some configs; treat as fully logged in.
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
      } else if (status === 502) {
        setError("텔레그램으로 코드를 보내지 못했습니다. 봇 설정을 확인하세요.");
      } else if (status === 503) {
        setError("서버에 텔레그램 2단계 인증이 설정되어 있지 않습니다.");
      } else {
        setError("로그인에 실패했습니다. 잠시 후 다시 시도하세요.");
      }
    }
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const result = await verify.mutateAsync({ data: { code } });
      if (result.authed) {
        await queryClient.invalidateQueries({ queryKey: getGetAuthStatusQueryKey() });
        setCode("");
      } else {
        setError("인증 코드가 올바르지 않습니다.");
      }
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: { error?: string; code?: string; attemptsRemaining?: number } } };
      const status = e?.response?.status;
      const data = e?.response?.data;
      if (status === 401) {
        const remaining = data?.attemptsRemaining;
        setError(
          typeof remaining === "number"
            ? `인증 코드가 올바르지 않습니다. 남은 시도: ${remaining}회`
            : "인증 코드가 올바르지 않습니다.",
        );
      } else if (status === 429 || data?.code === "TOO_MANY_ATTEMPTS") {
        setError("시도 횟수를 초과했습니다. 처음부터 다시 로그인하세요.");
        setStep("password");
      } else if (data?.code === "EXPIRED" || data?.code === "NO_CHALLENGE") {
        setError("인증 시간이 만료되었습니다. 다시 로그인하세요.");
        setStep("password");
      } else {
        setError("인증에 실패했습니다. 잠시 후 다시 시도하세요.");
      }
    }
  };

  const goBack = () => {
    setStep("password");
    setError(null);
    setInfo(null);
    setCode("");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center space-y-2">
          <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            {step === "password" ? (
              <Shield className="w-6 h-6 text-primary" />
            ) : (
              <Send className="w-6 h-6 text-primary" />
            )}
          </div>
          <CardTitle className="text-2xl">
            {step === "password" ? "소유자 인증" : "텔레그램 코드 입력"}
          </CardTitle>
          <CardDescription>
            {step === "password" ? (
              <>
                이 트레이딩 봇은 소유자만 접근할 수 있습니다.
                <br />
                비밀번호를 입력하면 텔레그램으로 인증 코드가 전송됩니다.
              </>
            ) : (
              <>텔레그램 봇이 보낸 6자리 코드를 입력하세요.</>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {step === "password" ? (
            <form onSubmit={submitPassword} className="space-y-4">
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
                {login.isPending ? "코드 전송 중..." : "다음"}
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                브루트포스 방지를 위해 15분간 최대 10회까지 시도할 수 있습니다.
              </p>
            </form>
          ) : (
            <form onSubmit={submitCode} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="code">인증 코드</Label>
                <Input
                  id="code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoFocus
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="123456"
                  className="text-center text-2xl tracking-[0.5em] font-mono"
                  disabled={verify.isPending}
                />
              </div>
              {info && !error && (
                <div className="text-sm text-blue-500 bg-blue-500/10 border border-blue-500/20 rounded-md px-3 py-2">
                  {info}
                </div>
              )}
              {error && (
                <div className="text-sm text-red-500 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
                  {error}
                </div>
              )}
              <Button
                type="submit"
                className="w-full"
                disabled={verify.isPending || code.length !== 6}
              >
                {verify.isPending ? "확인 중..." : "로그인"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={goBack}
                disabled={verify.isPending}
              >
                <ArrowLeft className="w-4 h-4 mr-2" />
                비밀번호 다시 입력
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
