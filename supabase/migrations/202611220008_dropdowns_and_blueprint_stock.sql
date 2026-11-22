-- Apply once after migrations 001-007, then deploy and reload the frontend.
-- Existing stock quantities, catalog entries, categories and price entries survive.
begin;
lock table public.rfm_stock in access exclusive mode;
lock table public.rfm_vendor_prices in share row exclusive mode;

create table public.rfm_price_qualities (
 room_id uuid not null references public.rfm_rooms(id) on delete cascade,
 name text not null check(length(name) between 1 and 80),
 primary key(room_id,name)
);
insert into public.rfm_price_qualities(room_id,name)
select distinct room_id,quality from public.rfm_vendor_prices;
alter table public.rfm_vendor_prices add constraint rfm_vendor_prices_quality_fkey
 foreign key(room_id,quality) references public.rfm_price_qualities(room_id,name);

create table public.rfm_blueprint_descriptions (
 room_id uuid not null references public.rfm_rooms(id) on delete cascade,
 name text not null check(length(name)<=80),
 primary key(room_id,name)
);
-- Empty string is the internal default for normal items and legacy Blueprint stock.
insert into public.rfm_blueprint_descriptions(room_id,name) select id,'' from public.rfm_rooms;
alter table public.rfm_stock add column blueprint_description text not null default '';
alter table public.rfm_stock drop constraint rfm_stock_pkey;
alter table public.rfm_stock add primary key(room_id,item_id,storage_id,blueprint_description);
alter table public.rfm_stock add constraint rfm_stock_blueprint_description_fkey
 foreign key(room_id,blueprint_description) references public.rfm_blueprint_descriptions(room_id,name);

alter table public.rfm_price_qualities enable row level security;
alter table public.rfm_blueprint_descriptions enable row level security;
revoke all on public.rfm_price_qualities,public.rfm_blueprint_descriptions from public,anon,authenticated;

create function public.rfm_add_dropdown_option(p_room uuid,p_kind text,p_name text)
returns boolean language plpgsql security definer set search_path = ''
as $f$
declare v_actor text;
begin
 v_actor:=public.rfm_inventory_admin(p_room);
 p_name:=trim(coalesce(p_name,''));
 if length(p_name) not between 1 and 80 then raise exception 'Enter an option name (1-80 characters)'; end if;
 if p_kind='quality' then
  lock table public.rfm_price_qualities in share row exclusive mode;
  if exists(select 1 from public.rfm_price_qualities where room_id=p_room and lower(name)=lower(p_name)) then raise exception 'That quality already exists'; end if;
  insert into public.rfm_price_qualities values(p_room,p_name);
  insert into public.rfm_price_activity(room_id,actor_id,actor_name,action,after_data)
  values(p_room,auth.uid(),v_actor,'quality_created',jsonb_build_object('name',p_name));
 elsif p_kind='blueprint' then
  lock table public.rfm_blueprint_descriptions in share row exclusive mode;
  if exists(select 1 from public.rfm_blueprint_descriptions where room_id=p_room and lower(name)=lower(p_name)) then raise exception 'That description already exists'; end if;
  insert into public.rfm_blueprint_descriptions values(p_room,p_name);
  insert into public.rfm_activity(room_id,actor_id,actor_name,action,detail)
  values(p_room,auth.uid(),v_actor,'blueprint_description_created','Created Blueprint description: '||p_name);
 else raise exception 'Invalid option type'; end if;
 return true;
end;
$f$;
revoke all on function public.rfm_add_dropdown_option(uuid,text,text) from public,anon,authenticated;
grant execute on function public.rfm_add_dropdown_option(uuid,text,text) to authenticated;

CREATE OR REPLACE FUNCTION public.rfm_change_stock(p_room uuid, p_action text, p_item uuid, p_from uuid, p_to uuid, p_quantity integer, p_blueprint_description text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_blueprint boolean; v_actor text; v_item text; v_from text := ''; v_to text := ''; v_before integer; v_after integer; v_destination_before integer; v_destination_after integer; v_detail text;
begin
 v_actor:=public.rfm_actor_name(p_room);
 p_blueprint_description:=coalesce(p_blueprint_description,'');
 if p_action is null then raise exception 'Invalid action'; end if;
 if p_action not in ('add','remove','move') then raise exception 'Invalid action'; end if;
 if p_quantity is null or p_quantity < 1 or p_quantity > 1000000 then raise exception 'Quantity must be between 1 and 1000000'; end if;
 select name,(lower(trim(name))='blueprint' and lower(trim(category))='blueprint') into v_item,v_blueprint from public.rfm_items where id=p_item and room_id=p_room for key share;
 if v_item is null then raise exception 'Item not found'; end if;
 if p_blueprint_description<>'' and not exists(select 1 from public.rfm_blueprint_descriptions where room_id=p_room and name=p_blueprint_description) then raise exception 'Choose a configured Blueprint description'; end if;
 if p_action='add' and p_blueprint_description<>'' and not v_blueprint then raise exception 'Descriptions are only available for the Blueprint item in the Blueprint category'; end if;
 if p_action='add' and v_blueprint and p_blueprint_description='' and not exists(select 1 from public.rfm_stock where room_id=p_room and item_id=p_item and storage_id=p_to and blueprint_description='') then raise exception 'Choose a Blueprint description'; end if;
 if p_blueprint_description<>'' then v_item:=v_item||' - '||p_blueprint_description; end if;
 if p_action in ('move','remove') then
   select name into v_from from public.rfm_storages where id=p_from and room_id=p_room;
   if v_from is null then raise exception 'Source storage not found'; end if;
 end if;
 if p_action in ('move','add') then
   select name into v_to from public.rfm_storages where id=p_to and room_id=p_room;
   if v_to is null then raise exception 'Destination storage not found'; end if;
 end if;
 if p_action='move' and p_from=p_to then raise exception 'Choose a different storage'; end if;
 if p_action in ('move','remove') then
   update public.rfm_stock set quantity=quantity-p_quantity
   where room_id=p_room and item_id=p_item and storage_id=p_from and blueprint_description=p_blueprint_description and quantity>=p_quantity
   returning quantity into v_after;
   if not found then raise exception 'Not enough items in source storage; refresh and try again'; end if;
   v_before:=v_after+p_quantity;
 end if;
 if p_action in ('move','add') then
   insert into public.rfm_stock(room_id,item_id,storage_id,quantity,blueprint_description)
   values(p_room,p_item,p_to,p_quantity,p_blueprint_description)
   on conflict (room_id,item_id,storage_id,blueprint_description) do update
   set quantity=public.rfm_stock.quantity+excluded.quantity
   returning quantity into v_destination_after;
   v_destination_before:=v_destination_after-p_quantity;
 end if;
 if p_action='add' then v_detail:=format('Before: %s, after: %s',v_destination_before,v_destination_after);
 elsif p_action='remove' then v_detail:=format('Before: %s, after: %s',v_before,v_after);
 else v_detail:=format('Source: %s to %s; destination: %s to %s',v_before,v_after,v_destination_before,v_destination_after); end if;
 insert into public.rfm_activity(room_id,actor_id,actor_name,action,item_name,from_name,to_name,quantity,detail)
 values(p_room,auth.uid(),v_actor,p_action,v_item,coalesce(v_from,''),coalesce(v_to,''),p_quantity,v_detail);
 -- Remove empty stock rows without deleting the master catalog item.
 delete from public.rfm_stock where room_id=p_room and item_id=p_item and blueprint_description=p_blueprint_description and quantity=0;
 return true;
end $function$;

create or replace function public.rfm_remove_all_stock(p_room uuid,p_item uuid,p_storage uuid,p_blueprint_description text)
returns integer language plpgsql security definer set search_path = ''
as $f$
declare v_actor text; v_item text; v_storage text; v_quantity integer;
begin
  v_actor:=public.rfm_actor_name(p_room);
  p_blueprint_description:=coalesce(p_blueprint_description,'');
  select name into v_item from public.rfm_items where room_id=p_room and id=p_item;
  select name into v_storage from public.rfm_storages where room_id=p_room and id=p_storage;
  if v_item is null or v_storage is null then raise exception 'Item or storage not found'; end if;
  -- DELETE locks the current row and returns its actual quantity atomically.
  delete from public.rfm_stock where room_id=p_room and item_id=p_item and storage_id=p_storage and blueprint_description=p_blueprint_description
  returning quantity into v_quantity;
  if coalesce(v_quantity,0)>0 then
    insert into public.rfm_activity(room_id,actor_id,actor_name,action,item_name,from_name,quantity,detail)
    values(p_room,auth.uid(),v_actor,'remove',v_item||case when p_blueprint_description<>'' then ' - '||p_blueprint_description else '' end,v_storage,v_quantity,
      format('Removed all. Before: %s, after: 0',v_quantity));
  end if;
  return coalesce(v_quantity,0);
end;
$f$;

-- Legacy signature targets only the undescribed row; it cannot mix variants.
create or replace function public.rfm_change_stock(p_room uuid,p_action text,p_item uuid,p_from uuid,p_to uuid,p_quantity integer)
returns boolean language sql security definer set search_path = ''
as $f$ select public.rfm_change_stock(p_room,p_action,p_item,p_from,p_to,p_quantity,''); $f$;
revoke all on function public.rfm_change_stock(uuid,text,uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.rfm_change_stock(uuid,text,uuid,uuid,uuid,integer) to authenticated;
revoke all on function public.rfm_change_stock(uuid,text,uuid,uuid,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.rfm_change_stock(uuid,text,uuid,uuid,uuid,integer,text) to authenticated;

create or replace function public.rfm_remove_all_stock(p_room uuid,p_item uuid,p_storage uuid)
returns integer language sql security definer set search_path = ''
as $f$ select public.rfm_remove_all_stock(p_room,p_item,p_storage,''); $f$;
revoke all on function public.rfm_remove_all_stock(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.rfm_remove_all_stock(uuid,uuid,uuid) to authenticated;
revoke all on function public.rfm_remove_all_stock(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.rfm_remove_all_stock(uuid,uuid,uuid,text) to authenticated;

create or replace function public.rfm_delete_entity(p_room uuid,p_kind text,p_id uuid)
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
    order by q.item_id,q.storage_id,q.blueprint_description for update;
  select coalesce(jsonb_agg(jsonb_build_object('item_id',q.item_id,'item',i.name||case when q.blueprint_description<>'' then ' - '||q.blueprint_description else '' end,'blueprint_description',q.blueprint_description,'storage_id',q.storage_id,'storage',s.name,'before',q.quantity,'after',0)),'[]'::jsonb)
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
    jsonb_build_object('kind',p_kind,'name',v_name,'id',p_id,'stock',v_stock)::text);
  return true;
end;
$f$;

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
  'blueprint_descriptions',coalesce((select jsonb_agg(name order by name) from public.rfm_blueprint_descriptions where room_id=p_room and name<>''),'[]'::jsonb),
  'stock',coalesce((select jsonb_agg(jsonb_build_object('item_id',item_id,'storage_id',storage_id,'quantity',quantity,'blueprint_description',blueprint_description)) from public.rfm_stock where room_id=p_room and quantity>0),'[]'::jsonb),
  'members',case when v_admin then coalesce((select jsonb_agg(jsonb_build_object('user_id',user_id,'name',display_name,'role',role,'active',active,'joined_at',joined_at) order by joined_at) from public.rfm_members where room_id=p_room),'[]'::jsonb) else '[]'::jsonb end,
  'invites',case when v_admin then coalesce((select jsonb_agg(jsonb_build_object('id',id,'role',role,'created_at',created_at,'expires_at',expires_at) order by created_at desc) from public.rfm_invites where room_id=p_room and canceled_at is null and redeemed_at is null and expires_at>now()),'[]'::jsonb) else '[]'::jsonb end,
  'logs',case when v_admin then coalesce((select jsonb_agg(row_to_json(a)::jsonb order by a.id desc) from (select id,actor_id,actor_name,action,item_name,from_name,to_name,quantity,detail,created_at from public.rfm_activity where room_id=p_room order by id desc limit 150) a),'[]'::jsonb) else '[]'::jsonb end
 );
end $function$;

revoke all on function public.rfm_get_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.rfm_get_snapshot(uuid) to authenticated;

create or replace function public.rfm_get_item_prices(p_room uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $f$
begin
 perform public.rfm_actor_name(p_room);
 return jsonb_build_object(
 'qualities',coalesce((select jsonb_agg(name order by name) from public.rfm_price_qualities where room_id=p_room),'[]'::jsonb),
 'vendors',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name,id) from public.rfm_price_vendors where room_id=p_room),'[]'::jsonb),
 'entries',coalesce((select jsonb_agg(jsonb_build_object('id',id,'vendor_id',vendor_id,'name',name,'quality',quality,'rolls',rolls) order by name,id) from public.rfm_vendor_prices where room_id=p_room),'[]'::jsonb));
end;
$f$;

notify pgrst,'reload schema';
commit;
