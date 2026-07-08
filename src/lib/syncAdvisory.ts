// Shared classifier for fin_sync_log.error_message.
//
// Some sync steps write a NON-fatal advisory into error_message while
// still completing successfully (ok=true). The canonical case is the
// mdapi-users daily sync running in createdAt-incremental mode: because
// /admin/players exposes no updatedAt, edits to existing rows aren't
// picked up. That's a known limitation, not a run failure — see
// MDAPI_USERS_CREATEDAT_FALLBACK_NOTE in mdapiUsersSync.ts, which starts
// the message with "ADVISORY (sync OK)".
//
// The UI (SyncCard freshness line, RecentSyncsCard status column) uses
// this to render such rows in amber/advisory styling rather than red/
// failure. Any message whose first non-space characters spell "ADVISORY"
// is treated as advisory, so future advisory notes only need that prefix
// to opt in.
export function isSyncAdvisory(
  errorMessage: string | null | undefined,
): boolean {
  if (!errorMessage) return false;
  return /^\s*advisory\b/i.test(errorMessage);
}
