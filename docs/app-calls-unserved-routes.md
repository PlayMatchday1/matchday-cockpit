# App calls the backend does not serve

Recorded 2026-11-06 for later. Read-only survey of the player app (`~/Code/frontend-offers-release`,
`app-1.87-17-152-25-gdb68cf4d`) against the backend (`~/Code/backend-logger-fix`, branch
fix/request-logging at 57bd888). In the request log these appear as `status 404, route null,
errorCode null`; the App activity card shows them as "The app asked for an address the server
doesn't have."

| App call | Where in the app | Backend |
|---|---|---|
| `GET matches/:id/match-price` | `src/http/api.ts:530` | no such route |
| `GET user-devices` | `src/http/api.ts:1138` | only `POST /user-devices` exists |
| `POST matches/join` (v1 `joinMatch`) | `src/http/api.ts:570` | only `/v2/matches/join` and `/v3/matches/join` |
| `POST player/payment-methods` (unversioned) | app payment-method save | only `POST /v2/player/payment-methods` (`players.controller.ts:76-88`, `@Version('2')`) |

**UNKNOWN:** whether any current screen still calls the first three. The survey found the
functions, not their callers. The App activity card will show it on production once the drain is
live: a 404 with no route on one of these paths is this table.
