
-- Create a secure helper to check admin status.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = (SELECT auth.uid())
      AND is_admin = true
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- Update admin SELECT permission.
DROP POLICY IF EXISTS "Admins can read all reviews"
ON public.reviews;

CREATE POLICY "Admins can read all reviews"
ON public.reviews
FOR SELECT
TO authenticated
USING (public.is_admin());

-- Update admin UPDATE permission.
DROP POLICY IF EXISTS "Admins can update reviews"
ON public.reviews;

CREATE POLICY "Admins can update reviews"
ON public.reviews
FOR UPDATE
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- Update admin DELETE permission.
DROP POLICY IF EXISTS "Admins can delete reviews"
ON public.reviews;

CREATE POLICY "Admins can delete reviews"
ON public.reviews
FOR DELETE
TO authenticated
USING (public.is_admin());
