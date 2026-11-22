-- Shortens newly issued invitations only. Existing codes remain valid.
begin;

create or replace function public.rfm_create_invite(p_room uuid, p_role text default 'member'::text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor text;
  v_code text;
  v_id uuid;
  v_attempt integer;
  v_expires timestamptz := now() + interval '14 days';
begin
  v_actor := public.rfm_require_admin(p_room);
  if p_role is null or p_role not in ('member','admin') then
    raise exception 'Invalid role';
  end if;

  for v_attempt in 1..5 loop
    -- The first 12 UUID hex characters are random (before version/variant bits).
    v_code := upper(left(replace(gen_random_uuid()::text, '-', ''), 12));
    insert into public.rfm_invites(room_id,code,role,created_by,expires_at)
    values(p_room,v_code,p_role,auth.uid(),v_expires)
    on conflict (code) do nothing
    returning id into v_id;
    exit when v_id is not null;
  end loop;
  if v_id is null then
    raise exception 'Could not issue an invitation. Please try again.';
  end if;

  insert into public.rfm_activity(room_id,actor_id,actor_name,action,detail)
  values(p_room,auth.uid(),v_actor,'invite_created','Created a one-time '||p_role||' invitation');
  return jsonb_build_object('id',v_id,'code',v_code,'role',p_role,'expires_at',v_expires);
end;
$function$;

revoke all on function public.rfm_create_invite(uuid,text) from public,anon,authenticated;
grant execute on function public.rfm_create_invite(uuid,text) to authenticated;
notify pgrst, 'reload schema';
commit;
