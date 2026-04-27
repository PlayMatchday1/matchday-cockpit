"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { firstAllowedPath, type AppUser } from "@/lib/useAuth";
import { supabase } from "@/lib/supabase";

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={null}>
      <CallbackContent />
    </Suspense>
  );
}

function CallbackContent() {
  const router = useRouter();
  const sp = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let handled = false;

    async function processUser(email: string | undefined) {
      if (handled || !mounted || !email) return;
      handled = true;

      const { data, error: lookupErr } = await supabase
        .from("app_users")
        .select("*")
        .eq("email", email.toLowerCase())
        .maybeSingle();

      if (lookupErr) {
        setError(lookupErr.message);
        setTimeout(() => mounted && router.replace("/login"), 2000);
        return;
      }

      const appUser = data as AppUser | null;
      if (!appUser) {
        await supabase.auth.signOut();
        if (mounted) router.replace("/login?error=not_authorized");
        return;
      }

      // Fire-and-forget last_login_at update. The Supabase query builder is
      // lazy — without .then() / await it never sends a request, which is
      // why this was silently failing on every sign-in. Log the error path
      // so RLS or auth issues surface in the console.
      supabase
        .from("app_users")
        .update({ last_login_at: new Date().toISOString() })
        .eq("id", appUser.id)
        .then(({ error: updateErr }) => {
          if (updateErr) {
            console.error(
              "Failed to update last_login_at:",
              updateErr.message,
            );
          }
        });

      const next = sp.get("next");
      router.replace(next ?? firstAllowedPath(appUser));
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session?.user) {
        processUser(session.user.email);
      }
    });

    supabase.auth.getSession().then(({ data }) => {
      if (data.session?.user) {
        processUser(data.session.user.email);
      }
    });

    const timeout = setTimeout(() => {
      if (!handled && mounted) {
        setError(
          "Couldn't establish a session. The link may have expired or been used already.",
        );
        setTimeout(() => mounted && router.replace("/login"), 2500);
      }
    }, 6000);

    return () => {
      mounted = false;
      subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, [router, sp]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-cream px-6">
      <div className="text-center">
        <div className="text-base font-bold text-deep-green">
          {error ? "Sign-in failed" : "Signing you in…"}
        </div>
        {error && <div className="mt-2 text-sm text-coral">{error}</div>}
      </div>
    </div>
  );
}
