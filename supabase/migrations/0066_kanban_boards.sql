-- ============================================================
-- Kanban boards: Field Pipeline + Tech Roadmap (Clubhouse tabs 3 & 4)
-- One shared engine, one card table with a board_type discriminator.
-- RLS: any authenticated user has full read/write (Clubhouse tab
-- access is enforced at the page guard; the boards themselves are
-- open to any signed-in Clubhouse user per requirement).
--
-- Applied manually via the Supabase SQL Editor before app code shipped
-- (30 Field Pipeline seed cards landed: 26 confirmed, 4 negotiation).
-- ============================================================

-- shared updated_at trigger
CREATE OR REPLACE FUNCTION kanban_set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- 1. cards
CREATE TABLE IF NOT EXISTS kanban_cards (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  board_type    text         NOT NULL CHECK (board_type IN ('field_pipeline','tech_roadmap')),
  title         text         NOT NULL,
  stage         text         NOT NULL,
  owner_user_id uuid         REFERENCES app_users(id) ON DELETE SET NULL,
  sort_order    double precision NOT NULL DEFAULT 0,
  data          jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT kanban_cards_stage_valid CHECK (
    (board_type = 'field_pipeline'
      AND stage IN ('backlog','contacted','negotiation','confirmed','archived'))
    OR (board_type = 'tech_roadmap'
      AND stage IN ('ideas','in_plan','in_progress','shipped'))
  )
);
CREATE INDEX IF NOT EXISTS kanban_cards_board_stage_idx
  ON kanban_cards(board_type, stage, sort_order);
CREATE INDEX IF NOT EXISTS kanban_cards_owner_idx
  ON kanban_cards(owner_user_id) WHERE owner_user_id IS NOT NULL;

DROP TRIGGER IF EXISTS kanban_cards_set_updated_at ON kanban_cards;
CREATE TRIGGER kanban_cards_set_updated_at BEFORE UPDATE ON kanban_cards
  FOR EACH ROW EXECUTE FUNCTION kanban_set_updated_at();

-- 2. checklist items (Field Pipeline per-card to-dos)
CREATE TABLE IF NOT EXISTS kanban_checklist_items (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id       uuid         NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
  text          text         NOT NULL,
  done          boolean      NOT NULL DEFAULT false,
  owner_user_id uuid         REFERENCES app_users(id) ON DELETE SET NULL,
  sort_order    double precision NOT NULL DEFAULT 0,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kanban_checklist_card_idx
  ON kanban_checklist_items(card_id, sort_order);

DROP TRIGGER IF EXISTS kanban_checklist_set_updated_at ON kanban_checklist_items;
CREATE TRIGGER kanban_checklist_set_updated_at BEFORE UPDATE ON kanban_checklist_items
  FOR EACH ROW EXECUTE FUNCTION kanban_set_updated_at();

-- 3. audit log
CREATE TABLE IF NOT EXISTS kanban_audit_log (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  board_type     text        NOT NULL,
  card_id        uuid,                       -- no FK: survives card deletion
  action         text        NOT NULL CHECK (action IN ('create','update','stage_change','delete')),
  actor_user_id  uuid        REFERENCES app_users(id) ON DELETE SET NULL,
  details        jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kanban_audit_board_idx ON kanban_audit_log(board_type, created_at DESC);
CREATE INDEX IF NOT EXISTS kanban_audit_card_idx  ON kanban_audit_log(card_id, created_at DESC);

-- 4. audit trigger (resolves actor from JWT email; skips pure reorders)
CREATE OR REPLACE FUNCTION kanban_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE actor uuid;
BEGIN
  SELECT id INTO actor FROM app_users
    WHERE lower(email) = lower(auth.jwt() ->> 'email') LIMIT 1;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO kanban_audit_log(board_type, card_id, action, actor_user_id, details)
      VALUES (NEW.board_type, NEW.id, 'create', actor,
              jsonb_build_object('title', NEW.title, 'stage', NEW.stage));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.stage IS DISTINCT FROM OLD.stage THEN
      INSERT INTO kanban_audit_log(board_type, card_id, action, actor_user_id, details)
        VALUES (NEW.board_type, NEW.id, 'stage_change', actor,
                jsonb_build_object('from', OLD.stage, 'to', NEW.stage));
    ELSIF (NEW.title, NEW.owner_user_id, NEW.data)
          IS DISTINCT FROM (OLD.title, OLD.owner_user_id, OLD.data) THEN
      INSERT INTO kanban_audit_log(board_type, card_id, action, actor_user_id, details)
        VALUES (NEW.board_type, NEW.id, 'update', actor,
                jsonb_build_object('title', NEW.title));
    END IF;  -- pure sort_order change: no audit row
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO kanban_audit_log(board_type, card_id, action, actor_user_id)
      VALUES (OLD.board_type, OLD.id, 'delete', actor);
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS kanban_cards_audit ON kanban_cards;
CREATE TRIGGER kanban_cards_audit
  AFTER INSERT OR UPDATE OR DELETE ON kanban_cards
  FOR EACH ROW EXECUTE FUNCTION kanban_audit();

-- 5. RLS: authenticated = full access on all three tables
ALTER TABLE kanban_cards            ENABLE ROW LEVEL SECURITY;
ALTER TABLE kanban_checklist_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE kanban_audit_log        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kanban_cards_rw ON kanban_cards;
CREATE POLICY kanban_cards_rw ON kanban_cards
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS kanban_checklist_rw ON kanban_checklist_items;
CREATE POLICY kanban_checklist_rw ON kanban_checklist_items
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS kanban_audit_read ON kanban_audit_log;
CREATE POLICY kanban_audit_read ON kanban_audit_log
  FOR SELECT TO authenticated USING (true);

-- 6. Seed Field Pipeline (30 cards from the prototype; idempotent).
INSERT INTO kanban_cards (board_type, title, stage, owner_user_id, sort_order, data)
SELECT 'field_pipeline', v.title, v.stage,
       (SELECT id FROM app_users WHERE full_name ILIKE v.owner || '%'
          ORDER BY created_at LIMIT 1),
       v.ord,
       jsonb_build_object('city', v.city, 'owner_label', v.owner)
FROM (VALUES
  ('Hammond Park','confirmed','ATL','Mike',1),
  ('PRUMC','confirmed','ATL','Mike',2),
  ('Hat / The Hattrick','confirmed','ATX','Nick',3),
  ('NEMP','confirmed','ATX','Nick',4),
  ('OC / Onion Creek - AMSA','confirmed','ATX','Nick',5),
  ('RR MPC','confirmed','ATX','Nick',6),
  ('San Juan Diego','confirmed','ATX','Nick',7),
  ('Stony Point High School','confirmed','ATX','Nick',8),
  ('Westlake','confirmed','ATX','Nick',9),
  ('Crossbar Rowlett','confirmed','DFW','Nick',10),
  ('Majestic Gardens','confirmed','DFW','Nick',11),
  ('Southlake Bicentennial Park','confirmed','DFW','Nick',12),
  ('Southlake Carroll Senior High School','confirmed','DFW','Nick',13),
  ('Galatzan Park','confirmed','ELP','Mike',14),
  ('ATH Katy','confirmed','HOU','Mike',15),
  ('ATH Pearland','confirmed','HOU','Mike',16),
  ('Katy ISC','confirmed','HOU','Mike',17),
  ('PAC Global','confirmed','HOU','Mike',18),
  ('The Hattrick','confirmed','HOU','Mike',19),
  ('Scissortail Park','confirmed','OKC','Mike',20),
  ('Mainland Sports Complex','confirmed','SATX','Mike',21),
  ('Soccer Central','confirmed','SATX','Mike',22),
  ('STAR Soccer Complex','confirmed','SATX','Mike',23),
  ('Centennial Commons','confirmed','STL','Mike',24),
  ('Lou Fusz Athletic Complex','confirmed','STL','Mike',25),
  ('Lou Fusz Training Center','confirmed','STL','Mike',26),
  ('Friends Select','negotiation','Philadelphia','George',27),
  ('Penn Park','negotiation','Philadelphia','George',28),
  ('Ballers','negotiation','Philadelphia','George',29),
  ('Phield House','negotiation','Philadelphia','George',30)
) AS v(title, stage, city, owner, ord)
WHERE NOT EXISTS (
  SELECT 1 FROM kanban_cards k
  WHERE k.board_type = 'field_pipeline' AND k.title = v.title
);
