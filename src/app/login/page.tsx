"use client";

import { Suspense, useEffect, useState } from "react";
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

function LoginContent() {
  const router = useRouter();
  const sp = useSearchParams();
  const { user, isLoading } = useAuth();
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errParam = sp.get("error");
  const nextParam = sp.get("next");

  useEffect(() => {
    if (!isLoading && user) {
      router.replace(nextParam ?? "/clubhouse");
    }
  }, [user, isLoading, router, nextParam]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || sending) return;
    setSending(true);
    setError(null);
    const callbackUrl = `${window.location.origin}/auth/callback${
      nextParam ? `?next=${encodeURIComponent(nextParam)}` : ""
    }`;
    const { error: err } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { emailRedirectTo: callbackUrl },
    });
    setSending(false);
    if (err) {
      setError(err.message);
      return;
    }
    setSent(true);
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
          Enter your work email and we&apos;ll send you a magic link.
        </p>

        {errParam === "not_authorized" && !sent && (
          <div className="mt-6 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-coral">
            That email isn&apos;t on the access list. Ask an admin to add you.
          </div>
        )}

        {sent ? (
          <div className="mt-8 rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10">
            <div className="text-base font-bold text-deep-green">
              Check your email
            </div>
            <p className="mt-1 text-sm text-deep-green/70">
              We sent a sign-in link to{" "}
              <span className="font-bold">{email}</span>. Click it to sign in.
            </p>
            <button
              type="button"
              onClick={() => {
                setSent(false);
                setEmail("");
              }}
              className="mt-4 text-sm font-medium text-deep-green/60 hover:text-deep-green"
            >
              Use a different email
            </button>
          </div>
        ) : (
          <form
            onSubmit={submit}
            className="mt-8 rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10"
          >
            <label className="block">
              <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
                Email
              </div>
              <input
                type="email"
                autoFocus
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
              {sending ? "Sending…" : "Send magic link"}
            </button>
            {error && (
              <div className="mt-3 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-coral">
                {error}
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
