-- Apply through Supabase SQL Editor in the existing RFM project.
-- Installing this function does not delete any logs; only calling it does.
begin;

create or replace function public.rfm_clear_logs(p_room uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_deleted bigint;
begin
  -- Hold the caller's membership stable until this transaction finishes.
  -- FOR SHARE conflicts with concurrent role changes and revocations.
  perform 1 from public.rfm_members as m
  where m.room_id = p_room and m.user_id = auth.uid()
  for share;

  -- Existing helper checks sign-in, active membership and admin role.
  perform public.rfm_require_admin(p_room);

  delete from public.rfm_activity where room_id = p_room;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$;

-- Supabase anonymous sign-ins use the authenticated database role.
-- Authorization still happens inside the function on every call.
revoke all on function public.rfm_clear_logs(uuid) from public, anon, authenticated;
grant execute on function public.rfm_clear_logs(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
