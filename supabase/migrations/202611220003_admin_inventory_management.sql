-- Apply after 202611220002_storage_groups.sql. Installing this deletes no data.
begin;
alter table public.rfm_storages add column image_data text
  check (image_data is null or (length(image_data) <= 350000
    and image_data ~ '^data:image/(webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$'));

-- Serialize admin mutations against changes to the caller's membership.
create function public.rfm_inventory_admin(p_room uuid)
returns text language plpgsql security definer set search_path = ''
as $f$
begin
  perform 1 from public.rfm_members where room_id=p_room and user_id=auth.uid() for share;
  return public.rfm_require_admin(p_room);
end;
$f$;
revoke all on function public.rfm_inventory_admin(uuid) from public, anon, authenticated;

create function public.rfm_update_item(p_room uuid,p_item uuid,p_name text,p_category text,p_detail text)
returns boolean language plpgsql security definer set search_path = ''
as $f$
declare v_actor text; v_old public.rfm_items%rowtype;
begin
  v_actor:=public.rfm_inventory_admin(p_room);
  p_name:=trim(coalesce(p_name,''));p_category:=coalesce(nullif(trim(p_category),''),'Other');p_detail:=coalesce(p_detail,'');
  if length(p_name) not between 1 and 100 or length(p_category)>50 or length(p_detail)>100 then raise exception 'Invalid item fields'; end if;
  -- Also serializes against catalog inserts to prevent duplicate names during edits.
  lock table public.rfm_items in share row exclusive mode;
  select * into v_old from public.rfm_items where room_id=p_room and id=p_item for update;
  if not found then raise exception 'Item not found'; end if;
  if exists(select 1 from public.rfm_items where room_id=p_room and id<>p_item and lower(name)=lower(p_name)) then raise exception 'That item is already in the master catalog'; end if;
  update public.rfm_items set name=p_name,category=p_category,detail=p_detail where room_id=p_room and id=p_item;
  insert into public.rfm_activity(room_id,actor_id,actor_name,action,item_name,detail)
  values(p_room,auth.uid(),v_actor,'item_updated',p_name,
    format('Updated item: %s',jsonb_build_object('before',jsonb_build_object('name',v_old.name,'category',v_old.category,'detail',v_old.detail),'after',jsonb_build_object('name',p_name,'category',p_category,'detail',p_detail))));
  return true;
end;
$f$;

create function public.rfm_update_storage(p_room uuid,p_storage uuid,p_name text,p_replace_image boolean,p_image_data text)
returns boolean language plpgsql security definer set search_path = ''
as $f$
declare v_actor text; v_old text;
begin
  v_actor:=public.rfm_inventory_admin(p_room);
  p_name:=trim(coalesce(p_name,''));
  if length(p_name) not between 1 and 80 then raise exception 'Enter a storage name (1-80 characters)'; end if;
  select name into v_old from public.rfm_storages where room_id=p_room and id=p_storage for update;
  if not found then raise exception 'Storage not found'; end if;
  update public.rfm_storages set name=p_name,image_data=case when p_replace_image then p_image_data else image_data end where room_id=p_room and id=p_storage;
  insert into public.rfm_activity(room_id,actor_id,actor_name,action,to_name,detail)
  values(p_room,auth.uid(),v_actor,'storage_updated',p_name,format('Storage %s renamed to %s%s',v_old,p_name,case when p_replace_image then '; picture changed or removed' else '' end));
  return true;
end;
$f$;

create function public.rfm_rename_storage_group(p_room uuid,p_group uuid,p_name text)
returns boolean language plpgsql security definer set search_path = ''
as $f$
declare v_actor text; v_old text;
begin
  v_actor:=public.rfm_inventory_admin(p_room);
  p_name:=trim(coalesce(p_name,''));
  if length(p_name) not between 1 and 80 then raise exception 'Enter a group name (1-80 characters)'; end if;
  select name into v_old from public.rfm_storage_groups where room_id=p_room and id=p_group for update;
  if not found then raise exception 'Storage group not found'; end if;
  update public.rfm_storage_groups set name=p_name where room_id=p_room and id=p_group;
  insert into public.rfm_activity(room_id,actor_id,actor_name,action,to_name,detail)
  values(p_room,auth.uid(),v_actor,'storage_group_updated',p_name,format('Storage group %s renamed to %s',v_old,p_name));
  return true;
end;
$f$;

create function public.rfm_delete_entity(p_room uuid,p_kind text,p_id uuid)
returns boolean language plpgsql security definer set search_path = ''
as $f$
declare v_actor text; v_name text; v_stock jsonb;
begin
  v_actor:=public.rfm_inventory_admin(p_room);
  if p_kind='item' then
    select name into v_name from public.rfm_items where room_id=p_room and id=p_id for update;
  elsif p_kind='storage' then
    select name into v_name from public.rfm_storages where room_id=p_room and id=p_id for update;
  elsif p_kind='storage_group' then
    select name into v_name from public.rfm_storage_groups where room_id=p_room and id=p_id for update;
    -- Prevent stock inserts into child storages while taking the deletion audit.
    perform 1 from public.rfm_storages where room_id=p_room and storage_group_id=p_id order by id for update;
  else raise exception 'Invalid entity type';
  end if;
  if v_name is null then raise exception 'Not found'; end if;
  -- Lock quantities before recording them. New stock inserts are blocked by the
  -- parent row locks above; existing quantities cannot change under this lock.
  perform 1 from public.rfm_stock q where q.room_id=p_room and
    (case p_kind when 'item' then q.item_id=p_id when 'storage' then q.storage_id=p_id
      else q.storage_id in(select id from public.rfm_storages where room_id=p_room and storage_group_id=p_id) end)
    order by q.item_id,q.storage_id for update;
  select coalesce(jsonb_agg(jsonb_build_object('item_id',q.item_id,'item',i.name,'storage_id',q.storage_id,'storage',s.name,'before',q.quantity,'after',0)),'[]'::jsonb)
  into v_stock from public.rfm_stock q join public.rfm_items i on i.id=q.item_id join public.rfm_storages s on s.id=q.storage_id
  where q.room_id=p_room and (case p_kind when 'item' then q.item_id=p_id when 'storage' then q.storage_id=p_id else s.storage_group_id=p_id end);
  if p_kind='item' then
    delete from public.rfm_items where room_id=p_room and id=p_id;
  elsif p_kind='storage' then
    delete from public.rfm_storages where room_id=p_room and id=p_id;
  else
    delete from public.rfm_storages where room_id=p_room and storage_group_id=p_id;
    delete from public.rfm_storage_groups where room_id=p_room and id=p_id;
  end if;
  -- Existing stock FKs cascade; historical activity has no item/storage FK.
  insert into public.rfm_activity(room_id,actor_id,actor_name,action,item_name,detail)
  values(p_room,auth.uid(),v_actor,p_kind||'_deleted',case when p_kind='item' then v_name else '' end,
    format('Deleted %s %s (%s); removed stock: %s',p_kind,v_name,p_id,v_stock));
  return true;
end;
$f$;

revoke all on function public.rfm_update_item(uuid,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.rfm_update_storage(uuid,uuid,text,boolean,text) from public,anon,authenticated;
revoke all on function public.rfm_rename_storage_group(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.rfm_delete_entity(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.rfm_update_item(uuid,uuid,text,text,text) to authenticated;
grant execute on function public.rfm_update_storage(uuid,uuid,text,boolean,text) to authenticated;
grant execute on function public.rfm_rename_storage_group(uuid,uuid,text) to authenticated;
grant execute on function public.rfm_delete_entity(uuid,text,uuid) to authenticated;

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
