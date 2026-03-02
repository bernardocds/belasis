BEGIN;

-- Step 6 hardening:
-- Lock down prospect_* tables that are currently outside tenant RLS boundaries.
-- These tables are not used by authenticated clinic users in the app runtime.

ALTER TABLE IF EXISTS public.prospect_chips ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.prospect_clinics ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.prospect_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.prospect_outreach ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS prospect_chips_service_all ON public.prospect_chips;
DROP POLICY IF EXISTS prospect_clinics_service_all ON public.prospect_clinics;
DROP POLICY IF EXISTS prospect_log_service_all ON public.prospect_log;
DROP POLICY IF EXISTS prospect_outreach_service_all ON public.prospect_outreach;

CREATE POLICY prospect_chips_service_all
ON public.prospect_chips
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE POLICY prospect_clinics_service_all
ON public.prospect_clinics
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE POLICY prospect_log_service_all
ON public.prospect_log
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE POLICY prospect_outreach_service_all
ON public.prospect_outreach
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

REVOKE ALL ON public.prospect_chips FROM anon, authenticated;
REVOKE ALL ON public.prospect_clinics FROM anon, authenticated;
REVOKE ALL ON public.prospect_log FROM anon, authenticated;
REVOKE ALL ON public.prospect_outreach FROM anon, authenticated;

GRANT ALL ON public.prospect_chips TO service_role;
GRANT ALL ON public.prospect_clinics TO service_role;
GRANT ALL ON public.prospect_log TO service_role;
GRANT ALL ON public.prospect_outreach TO service_role;

COMMIT;
