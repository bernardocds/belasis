BEGIN;

-- Step 2 hardening: close direct public access on critical admin/config tables
-- while preserving tenant-scoped access for authenticated clinic users.

-- 1) Ensure RLS is enabled
ALTER TABLE public.configuracoes_clinica ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.super_admins ENABLE ROW LEVEL SECURITY;

-- 2) Reset policies to a known safe baseline
DROP POLICY IF EXISTS configuracoes_clinica_select ON public.configuracoes_clinica;
DROP POLICY IF EXISTS configuracoes_clinica_insert ON public.configuracoes_clinica;
DROP POLICY IF EXISTS configuracoes_clinica_update ON public.configuracoes_clinica;
DROP POLICY IF EXISTS configuracoes_clinica_delete ON public.configuracoes_clinica;

DROP POLICY IF EXISTS super_admins_self_read ON public.super_admins;
DROP POLICY IF EXISTS super_admins_service_all ON public.super_admins;

-- 3) Tenant-scoped access to clinic configuration
-- Read: owner or member of clinic
CREATE POLICY configuracoes_clinica_select
ON public.configuracoes_clinica
FOR SELECT
TO authenticated
USING (
  clinic_id IN (
    SELECT id FROM public.clinicas WHERE user_id = auth.uid()
  )
  OR clinic_id IN (
    SELECT clinic_id FROM public.clinic_users WHERE user_id = auth.uid()
  )
);

-- Write: owner or admin/owner member only
CREATE POLICY configuracoes_clinica_insert
ON public.configuracoes_clinica
FOR INSERT
TO authenticated
WITH CHECK (
  clinic_id IN (
    SELECT id FROM public.clinicas WHERE user_id = auth.uid()
  )
  OR clinic_id IN (
    SELECT clinic_id
    FROM public.clinic_users
    WHERE user_id = auth.uid()
      AND role IN ('admin', 'owner')
  )
);

CREATE POLICY configuracoes_clinica_update
ON public.configuracoes_clinica
FOR UPDATE
TO authenticated
USING (
  clinic_id IN (
    SELECT id FROM public.clinicas WHERE user_id = auth.uid()
  )
  OR clinic_id IN (
    SELECT clinic_id
    FROM public.clinic_users
    WHERE user_id = auth.uid()
      AND role IN ('admin', 'owner')
  )
)
WITH CHECK (
  clinic_id IN (
    SELECT id FROM public.clinicas WHERE user_id = auth.uid()
  )
  OR clinic_id IN (
    SELECT clinic_id
    FROM public.clinic_users
    WHERE user_id = auth.uid()
      AND role IN ('admin', 'owner')
  )
);

CREATE POLICY configuracoes_clinica_delete
ON public.configuracoes_clinica
FOR DELETE
TO authenticated
USING (
  clinic_id IN (
    SELECT id FROM public.clinicas WHERE user_id = auth.uid()
  )
  OR clinic_id IN (
    SELECT clinic_id
    FROM public.clinic_users
    WHERE user_id = auth.uid()
      AND role IN ('admin', 'owner')
  )
);

-- 4) super_admins: no public writes, only self-read if directly queried
CREATE POLICY super_admins_self_read
ON public.super_admins
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

CREATE POLICY super_admins_service_all
ON public.super_admins
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- 5) Tighten grants
REVOKE ALL ON public.configuracoes_clinica FROM anon;
REVOKE ALL ON public.super_admins FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.configuracoes_clinica TO authenticated;
GRANT SELECT ON public.super_admins TO authenticated;

COMMIT;
