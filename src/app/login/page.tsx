"use client";

// Two-step OTP sign-in.
//
// Why OTP and not magic link: on iOS, tapping a magic link from
// Mail opens Safari. Safari sets the auth cookie. The installed
// MatchDay PWA has its own isolated storage and can't see that
// cookie — so operators end up signed in inside Safari but stuck
// on the login screen inside the PWA. Standard iOS PWA isolation,
// not a Supabase bug. Codes keep the whole verification flow
// inside whichever browser/PWA the user started in.
//
// Flow:
//   1. mode === "email" — collect email, signInWithOtp() emails a code
//   2. mode === "code"  — collect 6-digit code, verifyOtp() establishes
//                         the session in the current browser
//   3. router.replace("/auth/callback?next=…") so the existing post-
//      signin logic (app_users access check + last_login_at write)
//      runs for OTP exactly like it does for magic-link arrivals
//
// shouldCreateUser:false locks out unknown emails at step 1. Trade-
// off: new admins added to app_users must have a corresponding
// auth.users row pre-created in the Supabase dashboard before
// they can sign in for the first time.

import { Suspense, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/useAuth";
import { supabase } from "@/lib/supabase";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  );
}

type Mode = "email" | "code";

const RESEND_COOLDOWN_SEC = 30;

function LoginContent() {
  const router = useRouter();
  const sp = useSearchParams();
  const { user, isLoading } = useAuth();

  const [mode, setMode] = useState<Mode>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const codeInputRef = useRef<HTMLInputElement>(null);

  const errParam = sp.get("error");
  const nextParam = sp.get("next");

  // If the user lands here already signed in (e.g. nav from another
  // tab that signed them in), bounce them to the next destination.
  useEffect(() => {
    if (!isLoading && user) {
      router.replace(nextParam ?? "/clubhouse");
    }
  }, [user, isLoading, router, nextParam]);

  // Auto-focus the code input when we switch to code mode. Pairs
  // with autoComplete="one-time-code" so iOS Mail's banner offers
  // the code as a keyboard autofill suggestion as soon as the
  // input has focus.
  useEffect(() => {
    if (mode === "code") {
      codeInputRef.current?.focus();
    }
  }, [mode]);

  // Resend cooldown ticker. setInterval is fine here — exactly one
  // active timer per page lifetime, cleaned up on unmount.
  useEffect(() => {
    if (resendIn <= 0) return;
    const id = setInterval(() => {
      setResendIn((n) => (n > 0 ? n - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [resendIn]);

  async function sendCode(): Promise<void> {
    if (!email.trim() || sending) return;
    setSending(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { shouldCreateUser: false },
    });
    setSending(false);
    if (err) {
      setError(err.message);
      return;
    }
    setMode("code");
    setCode("");
    setResendIn(RESEND_COOLDOWN_SEC);
  }

  async function verify(): Promise<void> {
    const trimmed = code.trim();
    if (trimmed.length !== 6 || verifying) return;
    setVerifying(true);
    setError(null);
    const { error: err } = await supabase.auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token: trimmed,
      type: "email",
    });
    if (err) {
      setVerifying(false);
      setError(err.message);
      return;
    }
    // Session is set on the supabase client. Defer post-signin work
    // (app_users access check + last_login_at update) to the
    // existing /auth/callback page — same path the legacy magic-
    // link arrivals take. Don't clear `verifying` so the button
    // stays disabled through the redirect.
    router.replace(
      `/auth/callback${nextParam ? `?next=${encodeURIComponent(nextParam)}` : ""}`,
    );
  }

  function reset(): void {
    setMode("email");
    setCode("");
    setError(null);
    setResendIn(0);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-cream px-6 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Image
            src="/matchday-logo.png"
            alt="MatchDay"
            width={140}
            height={32}
            priority
            className="h-8 w-auto"
          />
        </div>
        <h1 className="font-display text-3xl uppercase leading-tight tracking-tight text-deep-green md:text-4xl">
          Sign in to MatchDay Clubhouse
        </h1>
        <p className="mt-2 text-sm text-deep-green/65">
          {mode === "email"
            ? "Enter your work email and we'll send you a 6-digit code."
            : "Check your email for a 6-digit code and enter it below."}
        </p>

        {errParam === "not_authorized" && mode === "email" && (
          <div className="mt-6 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-coral">
            That email isn&apos;t on the access list. Ask an admin to add you.
          </div>
        )}

        {mode === "email" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendCode();
            }}
            className="mt-8 rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10"
          >
            <label className="block">
              <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
                Email
              </div>
              <input
                type="email"
                autoFocus
                autoComplete="email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@playmatchday.com"
                className="mt-1 w-full rounded-md border border-cream-line bg-cream-soft px-3 py-2 text-sm text-deep-green placeholder:text-deep-green/40 focus:border-deep-green focus:outline-none"
                required
              />
            </label>
            <button
              type="submit"
              disabled={sending || !email.trim()}
              className="mt-4 w-full rounded-full bg-mint px-5 py-2.5 text-sm font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
            >
              {sending ? "Sending…" : "Send code"}
            </button>
            {error && (
              <div className="mt-3 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-coral">
                {error}
              </div>
            )}
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void verify();
            }}
            className="mt-8 rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10"
          >
            <div className="text-xs text-deep-green/65">
              Code sent to{" "}
              <span className="font-bold text-deep-green">{email}</span>
            </div>
            <label className="mt-4 block">
              <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
                6-digit code
              </div>
              <input
                ref={codeInputRef}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(e) =>
                  // Strip non-digits so paste-from-email still works
                  // when the email body wraps the code in spaces.
                  setCode(e.target.value.replace(/\D+/g, "").slice(0, 6))
                }
                placeholder="123456"
                className="mt-1 w-full rounded-md border border-cream-line bg-cream-soft px-3 py-3 text-center text-2xl font-bold tracking-[0.5em] text-deep-green placeholder:font-normal placeholder:tracking-widest placeholder:text-deep-green/30 focus:border-deep-green focus:outline-none"
                required
              />
            </label>
            <button
              type="submit"
              disabled={verifying || code.trim().length !== 6}
              className="mt-4 w-full rounded-full bg-mint px-5 py-2.5 text-sm font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
            >
              {verifying ? "Verifying…" : "Verify"}
            </button>
            {error && (
              <div className="mt-3 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-coral">
                {error}
              </div>
            )}
            <div className="mt-4 flex items-center justify-between text-xs">
              <button
                type="button"
                onClick={reset}
                className="text-deep-green/60 hover:text-deep-green"
              >
                Use a different email
              </button>
              <button
                type="button"
                onClick={() => void sendCode()}
                disabled={sending || resendIn > 0}
                className="font-medium text-deep-green/70 hover:text-deep-green disabled:opacity-50"
              >
                {resendIn > 0
                  ? `Resend in ${resendIn}s`
                  : sending
                    ? "Sending…"
                    : "Resend code"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
