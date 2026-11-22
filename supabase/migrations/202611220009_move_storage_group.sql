-- Apply after migrations 001-008, before deploying the frontend.
-- Changes only the parent group of an existing storage; stock stays untouched.
begin;
create function public.rfm_move_storage_group(p_room uuid,p_storage uuid,p_group uuid)
returns boolean language plpgsql security definer set search_path = ''
as $f$
declare v_actor text; v_storage public.rfm_storages%rowtype; v_from text; v_to text;
begin
 v_actor:=public.rfm_inventory_admin(p_room);
 -- Keep group deletion/renaming and storage movement serialized.
 lock table public.rfm_storage_groups in share row exclusive mode;
 select name into v_to from public.rfm_storage_groups where room_id=p_room and id=p_group;
 if not found then raise exception 'Destination storage group not found'; end if;
 select * into v_storage from public.rfm_storages where room_id=p_room and id=p_storage for update;
 if not found then raise exception 'Storage not found'; end if;
 if v_storage.storage_group_id=p_group then return false; end if;
 select name into v_from from public.rfm_storage_groups where room_id=p_room and id=v_storage.storage_group_id;
 update public.rfm_storages set storage_group_id=p_group where room_id=p_room and id=p_storage;
 insert into public.rfm_activity(room_id,actor_id,actor_name,action,item_name,from_name,to_name,detail)
 values(p_room,auth.uid(),v_actor,'storage_moved',v_storage.name,v_from,v_to,
 jsonb_build_object('storage_id',p_storage,'from_group_id',v_storage.storage_group_id,'to_group_id',p_group)::text);
 return true;
end;
$f$;
revoke all on function public.rfm_move_storage_group(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.rfm_move_storage_group(uuid,uuid,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
