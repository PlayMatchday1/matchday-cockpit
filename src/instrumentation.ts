// Next.js instrumentation hook — register() runs once when a server instance
// boots. We use it only for the detect-only credential-whitespace smoke detector
// (see envHygiene.ts): it warns, never trims and never throws, so a latent
// whitespace problem can never take production down on boot.

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { checkEnvWhitespace } = await import("@/lib/envHygiene");
    checkEnvWhitespace();
  }
}
