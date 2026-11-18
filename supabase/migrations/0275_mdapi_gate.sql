-- 0275: THE MATCHDAY API GATE — global request slots and a shared breaker (Ryan, 2026-11-18).
--
-- Apply via Supabase Dashboard, SQL Editor. One transaction. Adds two tables and three functions
-- (plain CREATE, so it fails and rolls back if any of those names already exists). Changes nothing
-- that already exists.
--
-- WHY. On 2026-11-17 the warm cron fired up to ~400 parallel GET /admin/matches and ran the
-- MatchDay API (one 1 GB Heroku dyno) out of memory. Every limit Clubhouse had lived inside one
-- process, and Vercel runs many processes, so nothing capped the total. These slots are the cap:
-- every request Clubhouse sends to the MatchDay API first takes a slot here, and gives it back when
-- the response is in. A slot is a LEASE: if a function dies holding one, it frees itself when the
-- lease runs out, so a crash can shrink the pool for seconds, never for good.
--
-- THREE LANES, so one kind of traffic can never take another's room:
--   write  2  — staff writes. Never queued behind reads.
--   staff  6  — what a person is waiting on: pages, the staff app, single lookups.
--   bulk   1  — every cron, sync and night-pass request. One at a time across all of Vercel.
-- Total in flight from Clubhouse: at most 9.
--
-- THE BREAKER. After a failed read the lane's breaker opens for every instance at once (bulk: 15,
-- 30, 60, then 120 minutes; staff: short). Writes are never blocked by it.

BEGIN;

CREATE TABLE public.mdapi_gate_slots (
  lane         text        NOT NULL CHECK (lane IN ('write', 'staff', 'bulk')),
  slot         integer     NOT NULL,
  holder       text,                 -- a random id per request; nothing about a player
  label        text,                 -- the endpoint PATTERN, digits replaced: '/admin/matches/:n'
  leased_until timestamptz,
  PRIMARY KEY (lane, slot)
);

INSERT INTO public.mdapi_gate_slots (lane, slot)
SELECT 'write', g FROM generate_series(1, 2) g
UNION ALL SELECT 'staff', g FROM generate_series(1, 6) g
UNION ALL SELECT 'bulk', 1
ON CONFLICT DO NOTHING;

CREATE TABLE public.mdapi_gate_breaker (
  env        text        NOT NULL CHECK (env IN ('production', 'staging', 'local')),
  lane       text        NOT NULL CHECK (lane IN ('staff', 'bulk')),
  open_until timestamptz,
  failures   integer     NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (env, lane)
);

-- Take a free slot in the lane (or one whose lease has run out). Returns
--   { "slot": n | null, "open_until": ts | null, "failures": n }
-- slot null = none free right now (the caller waits and asks again) or the breaker is open
-- (open_until set; the caller does not ask again until then). failures = reads failed in a row on
-- this lane, so a caller reports a success only when there is something to clear. One round trip.
CREATE FUNCTION public.mdapi_gate_acquire(p_env text, p_lane text, p_holder text, p_label text, p_lease_ms integer)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s integer; b timestamptz; f integer := 0;
BEGIN
  IF p_lane <> 'write' THEN
    SELECT open_until, failures INTO b, f FROM public.mdapi_gate_breaker WHERE env = p_env AND lane = p_lane;
    f := coalesce(f, 0);
    IF b IS NOT NULL AND b > now() THEN
      RETURN jsonb_build_object('slot', NULL, 'open_until', b, 'failures', f);
    END IF;
  END IF;
  UPDATE public.mdapi_gate_slots t
     SET holder = p_holder, label = left(p_label, 120), leased_until = now() + make_interval(secs => p_lease_ms / 1000.0)
   WHERE (t.lane, t.slot) = (
     SELECT lane, slot FROM public.mdapi_gate_slots
      WHERE lane = p_lane AND (leased_until IS NULL OR leased_until < now())
      ORDER BY slot LIMIT 1 FOR UPDATE SKIP LOCKED)
  RETURNING t.slot INTO s;
  RETURN jsonb_build_object('slot', s, 'open_until', NULL, 'failures', f);
END $$;

-- Give the slot back. Only the holder that took it can free it (a lease that ran out and was taken
-- by someone else is theirs now).
CREATE FUNCTION public.mdapi_gate_release(p_lane text, p_slot integer, p_holder text)
RETURNS void LANGUAGE sql AS $$
  UPDATE public.mdapi_gate_slots SET holder = NULL, label = NULL, leased_until = NULL
   WHERE lane = p_lane AND slot = p_slot AND holder = p_holder;
$$;

-- Record a read outcome for the breaker. ok = true closes it; ok = false opens it for the step
-- that matches the failure count (minutes, last step repeats).
CREATE FUNCTION public.mdapi_gate_report(p_env text, p_lane text, p_ok boolean, p_error text, p_steps_s integer[])
RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE f integer; u timestamptz;
BEGIN
  IF p_ok THEN
    UPDATE public.mdapi_gate_breaker SET failures = 0, open_until = NULL, updated_at = now()
     WHERE env = p_env AND lane = p_lane AND (failures <> 0 OR open_until IS NOT NULL);
    RETURN NULL;
  END IF;
  INSERT INTO public.mdapi_gate_breaker AS b (env, lane, failures, last_error, updated_at)
  VALUES (p_env, p_lane, 1, left(p_error, 200), now())
  ON CONFLICT (env, lane) DO UPDATE SET failures = b.failures + 1, last_error = left(p_error, 200), updated_at = now()
  RETURNING failures INTO f;
  u := now() + make_interval(secs => p_steps_s[least(f, array_length(p_steps_s, 1))]);
  UPDATE public.mdapi_gate_breaker SET open_until = u WHERE env = p_env AND lane = p_lane;
  RETURN u;
END $$;

-- Service role only.
ALTER TABLE public.mdapi_gate_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mdapi_gate_breaker ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mdapi_gate_slots, public.mdapi_gate_breaker FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.mdapi_gate_acquire(text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mdapi_gate_release(text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mdapi_gate_report(text, text, boolean, text, integer[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mdapi_gate_acquire(text, text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mdapi_gate_release(text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mdapi_gate_report(text, text, boolean, text, integer[]) TO service_role;

COMMIT;
