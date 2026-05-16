import AuthGate from "@/components/AuthGate";
import PwaInstallPrompt from "@/components/PwaInstallPrompt";

// All internal cockpit routes live under this group. AuthGate sits
// here (not in the root layout) so /partners/* and /login don't
// inherit the auth context.
//
// PwaInstallPrompt is mounted inside AuthGate so the banner only
// shows on auth-gated pages — never on /login. The component does
// its own viewport / browser / dismissal checks; this layout just
// puts it in the right tree.

export default function InternalLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <AuthGate>
      {children}
      <PwaInstallPrompt />
    </AuthGate>
  );
}
