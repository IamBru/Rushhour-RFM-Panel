-- Apply once after migration 003 (and retain subsequent migrations).
begin;
lock table public.rfm_items in share row exclusive mode;
create table public.rfm_categories (
  room_id uuid not null references public.rfm_rooms(id) on delete cascade,
  name text not null check (length(name) between 1 and 50),
  primary key (room_id,name)
);
-- Preserve exact existing categories and item records.
insert into public.rfm_categories(room_id,name)
select distinct room_id,category from public.rfm_items;
alter table public.rfm_categories enable row level security;
revoke all on table public.rfm_categories from public,anon,authenticated;
alter table public.rfm_items add constraint rfm_items_category_fkey
  foreign key(room_id,category) references public.rfm_categories(room_id,name)
  on update cascade on delete restrict;

alter table public.rfm_rooms add column logo_data text
  check (logo_data is null or (length(logo_data)<=350000
  and logo_data ~ '^data:image/(webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$'));

create function public.rfm_manage_category(p_room uuid,p_action text,p_name text,p_new_name text default '')
returns boolean language plpgsql security definer set search_path = ''
as $f$
declare v_actor text; v_target text;
begin
  v_actor:=public.rfm_inventory_admin(p_room);
  p_name:=trim(coalesce(p_name,''));p_new_name:=trim(coalesce(p_new_name,''));
  if p_action is null or p_action not in ('add','rename','delete') then raise exception 'Invalid action'; end if;
  v_target:=case when p_action='rename' then p_new_name else p_name end;
  if length(p_name) not between 1 and 50 or length(v_target) not between 1 and 50 then raise exception 'Enter a category name (1-50 characters)'; end if;
  -- Use the same lock ordering as item metadata edits; serializes name checks.
  lock table public.rfm_items in share row exclusive mode;
  lock table public.rfm_categories in share row exclusive mode;
  if p_action<>'add' and not exists(select 1 from public.rfm_categories where room_id=p_room and name=p_name) then raise exception 'Category not found'; end if;
  if p_action<>'delete' and exists(select 1 from public.rfm_categories where room_id=p_room and lower(name)=lower(v_target) and not (p_action='rename' and name=p_name)) then raise exception 'Category already exists'; end if;
  if p_action='add' then
    insert into public.rfm_categories(room_id,name) values(p_room,p_name);
  elsif p_action='rename' then
    update public.rfm_categories set name=p_new_name where room_id=p_room and name=p_name;
  else
    if exists(select 1 from public.rfm_items where room_id=p_room and category=p_name) then raise exception 'Reassign items before removing this category'; end if;
    delete from public.rfm_categories where room_id=p_room and name=p_name;
  end if;
  insert into public.rfm_activity(room_id,actor_id,actor_name,action,detail)
  values(p_room,auth.uid(),v_actor,'category_'||p_action,format('Category %s: %s%s',p_action,p_name,case when p_action='rename' then ' to '||p_new_name else '' end));
  return true;
end;
$f$;

create function public.rfm_set_logo(p_room uuid,p_image_data text)
returns boolean language plpgsql security definer set search_path = ''
as $f$
declare v_actor text;
begin
  v_actor:=public.rfm_inventory_admin(p_room);
  update public.rfm_rooms set logo_data=p_image_data where id=p_room;
  if not found then raise exception 'RFM group not found'; end if;
  insert into public.rfm_activity(room_id,actor_id,actor_name,action,detail)
  values(p_room,auth.uid(),v_actor,'logo_updated',case when p_image_data is null then 'Removed panel logo' else 'Changed panel logo' end);
  return true;
end;
$f$;
revoke all on function public.rfm_manage_category(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.rfm_set_logo(uuid,text) from public,anon,authenticated;
grant execute on function public.rfm_manage_category(uuid,text,text,text) to authenticated;
grant execute on function public.rfm_set_logo(uuid,text) to authenticated;

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
  'room',(select jsonb_build_object('id',id,'name',name,'logo_data',logo_data) from public.rfm_rooms where id=p_room),
  'viewer',jsonb_build_object('user_id',auth.uid(),'name',v_actor,'role',v_role),
  'categories',coalesce((select jsonb_agg(name order by name) from public.rfm_categories where room_id=p_room),'[]'::jsonb),
  'items',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'category',category,'detail',detail,'image_path',image_path) order by category,name) from public.rfm_items where room_id=p_room),'[]'::jsonb),
  'storage_groups',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by created_at,id) from public.rfm_storage_groups where room_id=p_room),'[]'::jsonb),
  'storages',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'storage_group_id',storage_group_id,'image_data',image_data) order by created_at,id) from public.rfm_storages where room_id=p_room),'[]'::jsonb),
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
