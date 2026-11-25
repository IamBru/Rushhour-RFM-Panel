-- Apply after 001-012. Additive: old clients and inventory export keep their existing RPC.
-- No data writes, new tables, changes to RLS, or changes to Storage permissions.
begin;
CREATE OR REPLACE FUNCTION public.rfm_get_panel_snapshot(p_room uuid, p_revision text default null)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor text; v_admin boolean; v_role text; v_data jsonb; v_revision text;
begin
 v_actor:=public.rfm_actor_name(p_room);
 v_admin:=public.rfm_is_admin(p_room);
 select role into v_role from public.rfm_members where room_id=p_room and user_id=auth.uid();
 v_data:=jsonb_build_object(
  'room',(select jsonb_build_object('id',id,'name',name,'logo_data',logo_data) from public.rfm_rooms where id=p_room),
  'viewer',jsonb_build_object('user_id',auth.uid(),'name',v_actor,'role',v_role),
  'categories',coalesce((select jsonb_agg(name order by name) from public.rfm_categories where room_id=p_room),'[]'::jsonb),
  'items',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'category',category,'detail',detail,'image_path',image_path) order by category,name,id) from public.rfm_items where room_id=p_room),'[]'::jsonb),
  'storage_groups',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by created_at,id) from public.rfm_storage_groups where room_id=p_room),'[]'::jsonb),
  'storages',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'storage_group_id',storage_group_id,'image_data',image_data) order by created_at,id) from public.rfm_storages where room_id=p_room),'[]'::jsonb),
  'blueprint_descriptions',coalesce((select jsonb_agg(name order by name) from public.rfm_blueprint_descriptions where room_id=p_room and name<>''),'[]'::jsonb),
  'stock',coalesce((select jsonb_agg(jsonb_build_object('item_id',item_id,'storage_id',storage_id,'quantity',quantity,'blueprint_description',blueprint_description) order by storage_id,item_id,blueprint_description) from public.rfm_stock where room_id=p_room and quantity>0),'[]'::jsonb),
  'members',case when v_admin then coalesce((select jsonb_agg(jsonb_build_object('user_id',user_id,'name',display_name,'role',role,'active',active,'joined_at',joined_at) order by joined_at,user_id) from public.rfm_members where room_id=p_room),'[]'::jsonb) else '[]'::jsonb end,
  'invites',case when v_admin then coalesce((select jsonb_agg(jsonb_build_object('id',id,'role',role,'created_at',created_at,'expires_at',expires_at) order by created_at desc,id) from public.rfm_invites where room_id=p_room and canceled_at is null and redeemed_at is null and expires_at>now()),'[]'::jsonb) else '[]'::jsonb end,
  'logs','[]'::jsonb
 );
 v_revision:=md5(v_data::text);
 -- Authorization above is checked on EVERY request, even when the payload is unchanged.
 return jsonb_build_object('revision',v_revision,'data',case when p_revision=v_revision then null else v_data end);
end $function$;

revoke all on function public.rfm_get_panel_snapshot(uuid,text) from public,anon,authenticated;
grant execute on function public.rfm_get_panel_snapshot(uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;
