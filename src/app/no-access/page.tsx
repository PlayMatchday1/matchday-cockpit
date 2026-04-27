"use client";

import { useAuth } from "@/lib/useAuth";

export default function NoAccessPage() {
  const { signOut } = useAuth();

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6 py-12">
      <div className="max-w-md text-center">
        <h1 className="font-display text-3xl uppercase leading-tight tracking-tight text-deep-green md:text-4xl">
          No access yet
        </h1>
        <p className="mt-3 text-sm text-deep-green/70">
          You&apos;re signed in but don&apos;t have access to any pages yet. An
          admin needs to grant you permissions.
        </p>
        <div className="mt-6 flex flex-col items-center gap-3">
          <a
            href="mailto:rmancuso@playmatchday.com?subject=Clubhouse%20access%20request"
            className="rounded-full bg-mint px-5 py-2 text-sm font-bold text-deep-green transition hover:bg-mint-hover"
          >
            Request access
          </a>
          <button
            type="button"
            onClick={signOut}
            className="text-sm font-medium text-deep-green/60 transition hover:text-deep-green"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
