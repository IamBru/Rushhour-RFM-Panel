-- Apply once in the existing project's Supabase SQL Editor before the UI update.
-- Existing storage IDs, stock and history are preserved. No RFM rooms are created.
begin;

-- Prevent old clients from inserting an ungrouped storage during the backfill.
lock table public.rfm_storages in access exclusive mode;

create table public.rfm_storage_groups (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rfm_rooms(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (room_id, id)
);

alter table public.rfm_storage_groups enable row level security;
revoke all on table public.rfm_storage_groups from public, anon, authenticated;

alter table public.rfm_storages add column storage_group_id uuid;

insert into public.rfm_storage_groups(room_id, name)
select id, 'Main storage group' from public.rfm_rooms;

update public.rfm_storages as s
set storage_group_id = g.id
from public.rfm_storage_groups as g where g.room_id = s.room_id;

alter table public.rfm_storages
  alter column storage_group_id set not null,
  add constraint rfm_storages_group_room_fkey
    foreign key (room_id, storage_group_id)
    references public.rfm_storage_groups(room_id, id);
create index rfm_storages_group_idx on public.rfm_storages(room_id, storage_group_id);

create function public.rfm_add_storage_group(p_room uuid, p_name text)
returns uuid language plpgsql security definer set search_path = ''
as $function$
declare v_actor text; v_id uuid; v_name text;
begin
  v_actor := public.rfm_actor_name(p_room);
  v_name := trim(coalesce(p_name, ''));
  if length(v_name) not between 1 and 80 then raise exception 'Enter a group name (1-80 characters)'; end if;
  insert into public.rfm_storage_groups(room_id, name)
  values(p_room, v_name) returning id into v_id;
  insert into public.rfm_activity(room_id, actor_id, actor_name, action, to_name)
  values(p_room, auth.uid(), v_actor, 'storage_group_created', v_name);
  return v_id;
end;
$function$;

create function public.rfm_add_storage(p_room uuid, p_name text, p_storage_group uuid)
returns uuid language plpgsql security definer set search_path = ''
as $function$
declare v_actor text; v_id uuid; v_name text;
begin
  v_actor := public.rfm_actor_name(p_room);
  v_name := trim(coalesce(p_name, ''));
  if length(v_name) not between 1 and 80 then raise exception 'Enter a storage name (1-80 characters)'; end if;
  if not exists(select 1 from public.rfm_storage_groups where id = p_storage_group and room_id = p_room)
  then raise exception 'Storage group not found'; end if;
  insert into public.rfm_storages(room_id, name, storage_group_id)
  values(p_room, v_name, p_storage_group) returning id into v_id;
  insert into public.rfm_activity(room_id, actor_id, actor_name, action, to_name)
  values(p_room, auth.uid(), v_actor, 'storage_created', v_name);
  return v_id;
end;
$function$;

-- Keep already-open versions of the old frontend working during deployment.
create or replace function public.rfm_add_storage(p_room uuid, p_name text)
returns uuid language plpgsql security definer set search_path = ''
as $function$
declare v_group uuid;
begin
  perform public.rfm_actor_name(p_room);
  select id into v_group from public.rfm_storage_groups
  where room_id = p_room order by created_at, id limit 1;
  return public.rfm_add_storage(p_room, p_name, v_group);
end;
$function$;

revoke all on function public.rfm_add_storage_group(uuid, text) from public, anon, authenticated;
revoke all on function public.rfm_add_storage(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.rfm_add_storage(uuid, text) from public, anon, authenticated;
grant execute on function public.rfm_add_storage_group(uuid, text) to authenticated;
grant execute on function public.rfm_add_storage(uuid, text, uuid) to authenticated;
grant execute on function public.rfm_add_storage(uuid, text) to authenticated;

-- Snapshot replacement follows, retaining the supplied authorization and log rules.
CREATE OR REPLACE FUNCTION public.rfm_get_snapshot(p_room uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor text; v_admin boolean; v_role text;
begin
 v_actor:=public.rfm_actor_name(p_room);
 v_admin:=public.rfm_is_admin(p_room);
 select role into v_role from public.rfm_members where room_id=p_room and user_id=auth.uid();
 return jsonb_build_object(
  'room',(select jsonb_build_object('id',id,'name',name) from public.rfm_rooms where id=p_room),
  'viewer',jsonb_build_object('user_id',auth.uid(),'name',v_actor,'role',v_role),
  'items',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'category',category,'detail',detail,'image_path',image_path) order by category,name) from public.rfm_items where room_id=p_room),'[]'::jsonb),
  'storage_groups',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by created_at,id) from public.rfm_storage_groups where room_id=p_room),'[]'::jsonb),
  'storages',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'storage_group_id',storage_group_id) order by created_at,id) from public.rfm_storages where room_id=p_room),'[]'::jsonb),
  'stock',coalesce((select jsonb_agg(jsonb_build_object('item_id',item_id,'storage_id',storage_id,'quantity',quantity)) from public.rfm_stock where room_id=p_room and quantity>0),'[]'::jsonb),
  'members',case when v_admin then coalesce((select jsonb_agg(jsonb_build_object('user_id',user_id,'name',display_name,'role',role,'active',active,'joined_at',joined_at) order by joined_at) from public.rfm_members where room_id=p_room),'[]'::jsonb) else '[]'::jsonb end,
  'invites',case when v_admin then coalesce((select jsonb_agg(jsonb_build_object('id',id,'role',role,'created_at',created_at,'expires_at',expires_at) order by created_at desc) from public.rfm_invites where room_id=p_room and canceled_at is null and redeemed_at is null and expires_at>now()),'[]'::jsonb) else '[]'::jsonb end,
  'logs',case when v_admin then coalesce((select jsonb_agg(row_to_json(a)::jsonb order by a.id desc) from (select id,actor_id,actor_name,action,item_name,from_name,to_name,quantity,detail,created_at from public.rfm_activity where room_id=p_room order by id desc limit 150) a),'[]'::jsonb) else '[]'::jsonb end
 );
end $function$;

revoke all on function public.rfm_get_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.rfm_get_snapshot(uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
