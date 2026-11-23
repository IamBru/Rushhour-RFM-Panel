-- Apply after 001-011. Restricts creation only; existing groups and stock are untouched.
begin;
create or replace function public.rfm_add_storage_group(p_room uuid, p_name text)
returns uuid language plpgsql security definer set search_path = ''
as $function$
declare v_actor text; v_id uuid; v_name text;
begin
  v_actor := public.rfm_inventory_admin(p_room);
  v_name := trim(coalesce(p_name, ''));
  if length(v_name) not between 1 and 80 then raise exception 'Enter a group name (1-80 characters)'; end if;
  insert into public.rfm_storage_groups(room_id, name)
  values(p_room, v_name) returning id into v_id;
  insert into public.rfm_activity(room_id, actor_id, actor_name, action, to_name)
  values(p_room, auth.uid(), v_actor, 'storage_group_created', v_name);
  return v_id;
end;
$function$;

revoke all on function public.rfm_add_storage_group(uuid,text) from public,anon,authenticated;
grant execute on function public.rfm_add_storage_group(uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;
