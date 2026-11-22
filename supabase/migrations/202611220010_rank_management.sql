-- Apply after 001-009. Family ranks never modify panel roles or inventory.
begin;
create table public.rfm_family_ranks (
 room_id uuid not null references public.rfm_rooms(id) on delete cascade,
 key text not null,
 name text not null check(length(trim(name)) between 1 and 80),
 subtitle text not null default '' check(length(subtitle)<=100),
 promotions text[] not null default '{}',
 position integer not null,
 version integer not null default 1,
 primary key(room_id,key)
);
insert into public.rfm_family_ranks(room_id,key,name,subtitle,promotions,position)
select r.id,v.* from public.rfm_rooms r cross join (values
 ('boss','Boss','Don / Godfather',array[]::text[],1),
 ('underboss','Underboss','',array[]::text[],2),
 ('consigliere','Consigliere','',array[]::text[],3),
 ('crew_chief','Crew Chief','',array[]::text[],4),
 ('caporegime','Caporegime','Capo',array[]::text[],5),
 ('lieutenant','Lieutenant','Tenente',array['Coordinator','Family Representative','Advisor','Treasurer'],6),
 ('soldier','Soldier','Soldato',array['Hustler','Enforcer','Fixer','Recruiter','Loyalist','Veteran'],7),
 ('associate','Associate','',array[]::text[],8),
 ('prospect','Prospect','Recruit',array[]::text[],9)
) v(key,name,subtitle,promotions,position);
create table public.rfm_family_assignments (
 room_id uuid not null,
 user_id uuid not null,
 rank_key text not null,
 promotion text not null default '',
 primary key(room_id,user_id),
 foreign key(room_id,rank_key) references public.rfm_family_ranks(room_id,key)
);
create table public.rfm_rank_activity (
 id bigint generated always as identity primary key,
 room_id uuid not null references public.rfm_rooms(id) on delete cascade,
 actor_id uuid not null,
 actor_name text not null,
 action text not null,
 before_data jsonb,
 after_data jsonb,
 created_at timestamptz not null default now()
);
alter table public.rfm_family_ranks enable row level security;
alter table public.rfm_family_assignments enable row level security;
alter table public.rfm_rank_activity enable row level security;
revoke all on public.rfm_family_ranks,public.rfm_family_assignments,public.rfm_rank_activity from public,anon,authenticated;

create function public.rfm_get_ranks(p_room uuid)
returns jsonb language plpgsql security definer set search_path = '' as $f$
begin
 perform public.rfm_actor_name(p_room);
 return jsonb_build_object(
 'ranks',coalesce((select jsonb_agg(to_jsonb(r) - 'room_id' order by position) from public.rfm_family_ranks r where room_id=p_room),'[]'::jsonb),
 'members',coalesce((select jsonb_agg(jsonb_build_object('user_id',m.user_id,'name',m.display_name,'rank_key',a.rank_key,'promotion',coalesce(a.promotion,'')) order by m.display_name,m.user_id)
 from public.rfm_members m left join public.rfm_family_assignments a on a.room_id=m.room_id and a.user_id=m.user_id
 where m.room_id=p_room and m.active),'[]'::jsonb));
end $f$;

create function public.rfm_edit_rank(p_room uuid,p_key text,p_name text,p_subtitle text,p_promotions text[],p_version integer)
returns boolean language plpgsql security definer set search_path = '' as $f$
declare v_actor text; v_old public.rfm_family_ranks%rowtype; v_new public.rfm_family_ranks%rowtype;
begin
 v_actor:=public.rfm_inventory_admin(p_room);
 p_name:=trim(coalesce(p_name,''));p_subtitle:=trim(coalesce(p_subtitle,''));p_promotions:=coalesce(p_promotions,array[]::text[]);
 if length(p_name) not between 1 and 80 or length(p_subtitle)>100 or cardinality(p_promotions)>20
 or exists(select 1 from unnest(p_promotions) x where x is null or length(trim(x)) not between 1 and 80 or x<>trim(x))
 or (select count(*)<>count(distinct lower(x)) from unnest(p_promotions) x) then raise exception 'Invalid rank fields or duplicate promotions'; end if;
 select * into v_old from public.rfm_family_ranks where room_id=p_room and key=p_key for update;
 if not found then raise exception 'Rank not found'; end if;
 if p_version is distinct from v_old.version then raise exception 'This rank changed. Reopen the editor and try again.'; end if;
 if p_key not in ('lieutenant','soldier') and cardinality(p_promotions)>0 then raise exception 'This rank has no silent promotions'; end if;
 if exists(select 1 from public.rfm_family_assignments where room_id=p_room and rank_key=p_key and promotion<>'' and not (promotion=any(p_promotions))) then
 raise exception 'Reassign members using a promotion before removing or renaming it'; end if;
 update public.rfm_family_ranks set name=p_name,subtitle=p_subtitle,promotions=p_promotions,version=version+1
 where room_id=p_room and key=p_key returning * into v_new;
 insert into public.rfm_rank_activity(room_id,actor_id,actor_name,action,before_data,after_data)
 values(p_room,auth.uid(),v_actor,'rank_edited',to_jsonb(v_old),to_jsonb(v_new));
 return true;
end $f$;

create function public.rfm_assign_family_rank(p_room uuid,p_user uuid,p_key text,p_promotion text)
returns boolean language plpgsql security definer set search_path = '' as $f$
declare v_actor text; v_name text; v_rank public.rfm_family_ranks%rowtype; v_before jsonb; v_after jsonb;
begin
 v_actor:=public.rfm_inventory_admin(p_room);
 select display_name into v_name from public.rfm_members where room_id=p_room and user_id=p_user and active for update;
 if not found then raise exception 'Active member not found'; end if;
 p_key:=coalesce(p_key,'');p_promotion:=coalesce(p_promotion,'');
 if p_key<>'' then
 select * into v_rank from public.rfm_family_ranks where room_id=p_room and key=p_key for share;
 if not found then raise exception 'Rank not found'; end if;
 if p_promotion<>'' and not(p_promotion=any(v_rank.promotions)) then raise exception 'Choose a promotion for this rank'; end if;
 elsif p_promotion<>'' then raise exception 'Choose a rank first'; end if;
 select to_jsonb(a) into v_before from public.rfm_family_assignments a where room_id=p_room and user_id=p_user;
 if p_key='' then delete from public.rfm_family_assignments where room_id=p_room and user_id=p_user;
 else
 insert into public.rfm_family_assignments(room_id,user_id,rank_key,promotion) values(p_room,p_user,p_key,p_promotion)
 on conflict(room_id,user_id) do update set rank_key=excluded.rank_key,promotion=excluded.promotion;
 select to_jsonb(a) into v_after from public.rfm_family_assignments a where room_id=p_room and user_id=p_user;
 end if;
 insert into public.rfm_rank_activity(room_id,actor_id,actor_name,action,before_data,after_data)
 values(p_room,auth.uid(),v_actor,'member_rank_assigned',jsonb_build_object('member_name',v_name,'assignment',v_before),jsonb_build_object('member_name',v_name,'assignment',v_after));
 return true;
end $f$;
revoke all on function public.rfm_get_ranks(uuid),public.rfm_edit_rank(uuid,text,text,text,text[],integer),public.rfm_assign_family_rank(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.rfm_get_ranks(uuid),public.rfm_edit_rank(uuid,text,text,text,text[],integer),public.rfm_assign_family_rank(uuid,uuid,text,text) to authenticated;
notify pgrst,'reload schema';
commit;
