-- Apply after 013. Old snapshot RPCs remain available for already-open clients.
-- Read-only synchronization: no table, policy, stock, history or image changes.
begin;
create or replace function public.rfm_get_panel_delta(p_room uuid, p_revisions jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
 v_data jsonb;
 v_key text;
 v_value jsonb;
 v_hash text;
 v_revisions jsonb := '{}'::jsonb;
 v_changes jsonb := '{}'::jsonb;
begin
 -- Reuse the existing authorized read with no revision so membership and admin
 -- checks always run. A client's revision map never grants access to data.
 v_data := public.rfm_get_panel_snapshot(p_room, null)->'data';
 if v_data is null or jsonb_typeof(v_data) <> 'object' then
  raise exception 'Panel snapshot unavailable';
 end if;
 if p_revisions is null or jsonb_typeof(p_revisions) <> 'object' then
  p_revisions := '{}'::jsonb;
 end if;
 -- Each collection is replaced atomically, including empty arrays after deletes.
 -- Stock includes every Blueprint description; it cannot merge separate variants.
 for v_key, v_value in select key,value from jsonb_each(v_data - 'logs') loop
  v_hash := md5(v_value::text);
  v_revisions := v_revisions || jsonb_build_object(v_key,v_hash);
  if (p_revisions->>v_key) is distinct from v_hash then
   v_changes := v_changes || jsonb_build_object(v_key,v_value);
  end if;
 end loop;
 return jsonb_build_object('revision',v_revisions,'data',v_changes);
end $function$;
revoke all on function public.rfm_get_panel_delta(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.rfm_get_panel_delta(uuid,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
