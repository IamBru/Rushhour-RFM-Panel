-- Independent Item Prices module in the existing RFM room. No inventory changes.
begin;
create table public.rfm_price_vendors (
 id uuid primary key default gen_random_uuid(),
 room_id uuid not null references public.rfm_rooms(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 100),
 unique(room_id,id)
);
create table public.rfm_vendor_prices (
 id uuid primary key default gen_random_uuid(),
 room_id uuid not null,
 vendor_id uuid not null,
 name text not null check(length(trim(name)) between 1 and 100),
 quality text not null check(length(trim(quality)) between 1 and 80),
 rolls text not null check(length(rolls)<=80 and rolls ~ '^[0-9]+([.][0-9]+)?(/[0-9]+([.][0-9]+)?)*$'),
 foreign key(room_id,vendor_id) references public.rfm_price_vendors(room_id,id) on delete cascade
);
create index rfm_vendor_prices_vendor_idx on public.rfm_vendor_prices(room_id,vendor_id);
create table public.rfm_price_activity (
 id bigint generated always as identity primary key,
 room_id uuid not null references public.rfm_rooms(id) on delete cascade,
 actor_id uuid not null,
 actor_name text not null,
 action text not null,
 before_data jsonb,
 after_data jsonb,
 created_at timestamptz not null default now()
);
alter table public.rfm_price_vendors enable row level security;
alter table public.rfm_vendor_prices enable row level security;
alter table public.rfm_price_activity enable row level security;
revoke all on public.rfm_price_vendors,public.rfm_vendor_prices,public.rfm_price_activity from public,anon,authenticated;

create function public.rfm_get_item_prices(p_room uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $f$
begin
 perform public.rfm_actor_name(p_room);
 return jsonb_build_object(
 'vendors',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name,id) from public.rfm_price_vendors where room_id=p_room),'[]'::jsonb),
 'entries',coalesce((select jsonb_agg(jsonb_build_object('id',id,'vendor_id',vendor_id,'name',name,'quality',quality,'rolls',rolls) order by name,id) from public.rfm_vendor_prices where room_id=p_room),'[]'::jsonb));
end;
$f$;

create function public.rfm_manage_item_prices(p_room uuid,p_action text,p_id uuid,p_vendor uuid,p_name text,p_quality text,p_rolls text)
returns uuid language plpgsql security definer set search_path = ''
as $f$
declare v_actor text; v_before jsonb; v_after jsonb; v_id uuid:=p_id;
begin
 v_actor:=public.rfm_inventory_admin(p_room);
 p_name:=trim(coalesce(p_name,''));p_quality:=trim(coalesce(p_quality,''));p_rolls:=trim(coalesce(p_rolls,''));
 if p_action is null or p_action not in ('save_vendor','save_entry','delete_vendor','delete_entry') then raise exception 'Invalid action'; end if;
 if p_action in ('save_vendor','delete_vendor') then
  if p_id is not null then
   select to_jsonb(v) into v_before from public.rfm_price_vendors v where room_id=p_room and id=p_id for update;
   if not found then raise exception 'Vendor not found'; end if;
  end if;
  if p_action='delete_vendor' then
   if p_id is null then raise exception 'Vendor required'; end if;
   perform 1 from public.rfm_vendor_prices where room_id=p_room and vendor_id=p_id order by id for update;
   v_before:=v_before||jsonb_build_object('entries',coalesce((select jsonb_agg(to_jsonb(e)) from public.rfm_vendor_prices e where room_id=p_room and vendor_id=p_id),'[]'::jsonb));
   delete from public.rfm_price_vendors where room_id=p_room and id=p_id;
  else
   if p_id is null then insert into public.rfm_price_vendors(room_id,name) values(p_room,p_name) returning id into v_id;
   else update public.rfm_price_vendors set name=p_name where room_id=p_room and id=p_id; end if;
   select to_jsonb(v) into v_after from public.rfm_price_vendors v where id=v_id;
  end if;
 else
  if p_action='save_entry' then
   perform 1 from public.rfm_price_vendors where room_id=p_room and id=p_vendor for key share;
   if not found then raise exception 'Vendor not found'; end if;
  end if;
  if p_id is not null then
   select to_jsonb(e) into v_before from public.rfm_vendor_prices e where room_id=p_room and id=p_id for update;
   if not found then raise exception 'Price entry not found'; end if;
  end if;
  if p_action='delete_entry' then
   if p_id is null then raise exception 'Price entry required'; end if;
   delete from public.rfm_vendor_prices where room_id=p_room and id=p_id;
  else
   if p_id is null then insert into public.rfm_vendor_prices(room_id,vendor_id,name,quality,rolls) values(p_room,p_vendor,p_name,p_quality,p_rolls) returning id into v_id;
   else update public.rfm_vendor_prices set vendor_id=p_vendor,name=p_name,quality=p_quality,rolls=p_rolls where room_id=p_room and id=p_id; end if;
   select to_jsonb(e) into v_after from public.rfm_vendor_prices e where id=v_id;
  end if;
 end if;
 insert into public.rfm_price_activity(room_id,actor_id,actor_name,action,before_data,after_data)
 values(p_room,auth.uid(),v_actor,p_action,v_before,v_after);
 return v_id;
end;
$f$;
revoke all on function public.rfm_get_item_prices(uuid) from public,anon,authenticated;
revoke all on function public.rfm_manage_item_prices(uuid,text,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.rfm_get_item_prices(uuid) to authenticated;
grant execute on function public.rfm_manage_item_prices(uuid,text,uuid,uuid,text,text,text) to authenticated;
notify pgrst,'reload schema';
commit;
