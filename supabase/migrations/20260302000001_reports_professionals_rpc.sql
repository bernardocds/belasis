BEGIN;

CREATE OR REPLACE FUNCTION public.get_clinic_professionals_report(p_clinic_id uuid)
RETURNS TABLE (
  user_id uuid,
  email text,
  role text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.clinic_users cu
    WHERE cu.clinic_id = p_clinic_id
      AND cu.user_id = auth.uid()
      AND cu.role IN ('owner', 'admin', 'doctor')
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    cu.user_id,
    au.email::text,
    cu.role::text
  FROM public.clinic_users cu
  JOIN auth.users au ON au.id = cu.user_id
  WHERE cu.clinic_id = p_clinic_id
    AND cu.role IN ('owner', 'admin', 'doctor');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_clinic_professionals_report(uuid) TO authenticated;

COMMIT;
