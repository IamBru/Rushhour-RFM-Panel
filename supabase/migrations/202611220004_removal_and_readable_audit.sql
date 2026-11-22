-- Apply after migration 003. Installing this does not delete existing records.
begin;

create function public.rfm_remove_all_stock(p_room uuid,p_item uuid,p_storage uuid)
returns integer language plpgsql security definer set search_path = ''
as $f$
declare v_actor text; v_item text; v_storage text; v_quantity integer;
begin
  v_actor:=public.rfm_actor_name(p_room);
  select name into v_item from public.rfm_items where room_id=p_room and id=p_item;
  select name into v_storage from public.rfm_storages where room_id=p_room and id=p_storage;
  if v_item is null or v_storage is null then raise exception 'Item or storage not found'; end if;
  -- DELETE locks the current row and returns its actual quantity atomically.
  delete from public.rfm_stock where room_id=p_room and item_id=p_item and storage_id=p_storage
  returning quantity into v_quantity;
  if coalesce(v_quantity,0)>0 then
    insert into public.rfm_activity(room_id,actor_id,actor_name,action,item_name,from_name,quantity,detail)
    values(p_room,auth.uid(),v_actor,'remove',v_item,v_storage,v_quantity,
      format('Removed all. Before: %s, after: 0',v_quantity));
  end if;
  return coalesce(v_quantity,0);
end;
$f$;
revoke all on function public.rfm_remove_all_stock(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.rfm_remove_all_stock(uuid,uuid,uuid) to authenticated;

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
    jsonb_build_object('kind',p_kind,'name',v_name,'id',p_id,'stock',v_stock)::text);
  return true;
end;
$f$;

CREATE OR REPLACE FUNCTION public.rfm_change_stock(p_room uuid, p_action text, p_item uuid, p_from uuid, p_to uuid, p_quantity integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor text; v_item text; v_from text := ''; v_to text := ''; v_before integer; v_after integer; v_destination_before integer; v_destination_after integer; v_detail text;
begin
 v_actor:=public.rfm_actor_name(p_room);
 if p_action not in ('add','remove','move') then raise exception 'Invalid action'; end if;
 if p_quantity is null or p_quantity < 1 or p_quantity > 1000000 then raise exception 'Quantity must be between 1 and 1000000'; end if;
 select name into v_item from public.rfm_items where id=p_item and room_id=p_room;
 if v_item is null then raise exception 'Item not found'; end if;
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
   where room_id=p_room and item_id=p_item and storage_id=p_from and quantity>=p_quantity
   returning quantity into v_after;
   if not found then raise exception 'Not enough items in source storage; refresh and try again'; end if;
   v_before:=v_after+p_quantity;
 end if;
 if p_action in ('move','add') then
   insert into public.rfm_stock(room_id,item_id,storage_id,quantity)
   values(p_room,p_item,p_to,p_quantity)
   on conflict (room_id,item_id,storage_id) do update
   set quantity=public.rfm_stock.quantity+excluded.quantity
   returning quantity into v_destination_after;
   v_destination_before:=v_destination_after-p_quantity;
 end if;
 if p_action='add' then v_detail:=format('Before: %s, after: %s',v_destination_before,v_destination_after);
 elsif p_action='remove' then v_detail:=format('Before: %s, after: %s',v_before,v_after);
 else v_detail:=format('Source: %s→%s; destination: %s→%s',v_before,v_after,v_destination_before,v_destination_after); end if;
 insert into public.rfm_activity(room_id,actor_id,actor_name,action,item_name,from_name,to_name,quantity,detail)
 values(p_room,auth.uid(),v_actor,p_action,v_item,coalesce(v_from,''),coalesce(v_to,''),p_quantity,v_detail);
 -- Remove empty stock rows without deleting the master catalog item.
 delete from public.rfm_stock where room_id=p_room and item_id=p_item and quantity=0;
 return true;
end $function$;

notify pgrst, 'reload schema';
commit;
