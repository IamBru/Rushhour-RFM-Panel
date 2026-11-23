-- Apply after 001-010. Preserves inventory, memberships and historical actor names.
begin;
create or replace function public.rfm_add_storage(p_room uuid, p_name text, p_storage_group uuid)
returns uuid language plpgsql security definer set search_path = ''
as $function$
declare v_actor text; v_id uuid; v_name text;
begin
  v_actor := public.rfm_inventory_admin(p_room);
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


-- The legacy two-argument overload delegates to this guarded three-argument RPC.
create function public.rfm_update_own_name(p_room uuid,p_name text)
returns boolean language plpgsql security definer set search_path = '' as $f$
declare v_old text;
begin
 select display_name into v_old from public.rfm_members where room_id=p_room and user_id=auth.uid() and active for update;
 if not found then raise exception 'Active membership required'; end if;
 p_name:=trim(coalesce(p_name,''));
 if length(p_name) not between 1 and 40 then raise exception 'Enter a name (1-40 characters)'; end if;
 if p_name=v_old then return false; end if;
 update public.rfm_members set display_name=p_name where room_id=p_room and user_id=auth.uid();
 insert into public.rfm_activity(room_id,actor_id,actor_name,action,detail)
 values(p_room,auth.uid(),v_old,'profile_updated',format('Changed display name from %s to %s',v_old,p_name));
 return true;
end $f$;

alter table public.rfm_price_qualities add column color text not null default '#e5e7eb'
 check(color in ('#e5e7eb','#86efac','#60a5fa','#c084fc','#fbbf24','#fb7185'));
create function public.rfm_add_vendor_quality(p_room uuid,p_name text,p_color text)
returns boolean language plpgsql security definer set search_path = '' as $f$
declare v_actor text;
begin
 v_actor:=public.rfm_inventory_admin(p_room);
 if p_color is null or p_color not in ('#e5e7eb','#86efac','#60a5fa','#c084fc','#fbbf24','#fb7185') then raise exception 'Choose a preset rarity color'; end if;
 perform public.rfm_add_dropdown_option(p_room,'quality',p_name);
 update public.rfm_price_qualities set color=p_color where room_id=p_room and name=trim(p_name);
 insert into public.rfm_price_activity(room_id,actor_id,actor_name,action,after_data)
 values(p_room,auth.uid(),v_actor,'quality_color_set',jsonb_build_object('name',trim(p_name),'color',p_color));
 return true;
end $f$;
create or replace function public.rfm_get_item_prices(p_room uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $f$
begin
 perform public.rfm_actor_name(p_room);
 return jsonb_build_object(
 'quality_colors',coalesce((select jsonb_object_agg(name,color) from public.rfm_price_qualities where room_id=p_room),'{}'::jsonb),
 'qualities',coalesce((select jsonb_agg(name order by name) from public.rfm_price_qualities where room_id=p_room),'[]'::jsonb),
 'vendors',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name,id) from public.rfm_price_vendors where room_id=p_room),'[]'::jsonb),
 'entries',coalesce((select jsonb_agg(jsonb_build_object('id',id,'vendor_id',vendor_id,'name',name,'quality',quality,'rolls',rolls) order by name,id) from public.rfm_vendor_prices where room_id=p_room),'[]'::jsonb));
end;
$f$;

create or replace function public.rfm_add_dropdown_option(p_room uuid,p_kind text,p_name text)
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
  insert into public.rfm_price_qualities(room_id,name) values(p_room,p_name);
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

revoke all on function public.rfm_update_own_name(uuid,text),public.rfm_add_vendor_quality(uuid,text,text) from public,anon,authenticated;
grant execute on function public.rfm_update_own_name(uuid,text),public.rfm_add_vendor_quality(uuid,text,text) to authenticated;
notify pgrst,'reload schema';
commit;
