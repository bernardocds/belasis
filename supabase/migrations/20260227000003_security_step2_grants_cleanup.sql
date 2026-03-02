BEGIN;

-- Remove inherited broad grants and keep only what the app needs.

-- configuracoes_clinica: authenticated can only CRUD (subject to RLS), anon has no access
REVOKE ALL ON public.configuracoes_clinica FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.configuracoes_clinica TO authenticated;

-- plans: public read-only table
REVOKE ALL ON public.plans FROM anon, authenticated;
GRANT SELECT ON public.plans TO anon, authenticated;

COMMIT;
