import AuthGate from "@/components/AuthGate";

// All internal cockpit routes live under this group. AuthGate sits
// here (not in the root layout) so /partners/* and /login don't
// inherit the auth context.

export default function InternalLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <AuthGate>{children}</AuthGate>;
}
