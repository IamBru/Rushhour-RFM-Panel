-- Apply after 014, before publishing the updated frontend.
-- Read-only wrappers: existing RPCs perform membership checks on EVERY request,
-- even when the revision matches. No records, policies or grants are widened.
begin;
create or replace function public.rfm_get_prices_snapshot(p_room uuid, p_revision text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_data jsonb; v_revision text;
begin
 v_data := public.rfm_get_item_prices(p_room);
 v_revision := md5(v_data::text);
 return jsonb_build_object('revision',v_revision,'data',
  case when p_revision is distinct from v_revision then v_data else null end);
end $function$;
revoke all on function public.rfm_get_prices_snapshot(uuid,text) from public,anon,authenticated;
grant execute on function public.rfm_get_prices_snapshot(uuid,text) to authenticated;
create or replace function public.rfm_get_ranks_snapshot(p_room uuid, p_revision text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_data jsonb; v_revision text;
begin
 v_data := public.rfm_get_ranks(p_room);
 v_revision := md5(v_data::text);
 return jsonb_build_object('revision',v_revision,'data',
  case when p_revision is distinct from v_revision then v_data else null end);
end $function$;
revoke all on function public.rfm_get_ranks_snapshot(uuid,text) from public,anon,authenticated;
grant execute on function public.rfm_get_ranks_snapshot(uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;
