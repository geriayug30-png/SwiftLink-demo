-- SwiftLink live backend. Run once in the Supabase SQL editor as project owner.
begin;
create table public.sl_hospitals (
  id uuid primary key default gen_random_uuid(), name text not null,
  city text not null, active boolean not null default false
);
create table public.sl_staff (
  hospital_id uuid references public.sl_hospitals on delete cascade,
  user_id uuid references auth.users on delete cascade,
  primary key (hospital_id, user_id)
);
create table public.sl_staff_invites (
  hospital_id uuid references public.sl_hospitals on delete cascade,
  email text not null check (email=lower(trim(email))), primary key(hospital_id,email)
);
create table public.sl_capacity (
  hospital_id uuid references public.sl_hospitals on delete cascade,
  kind text check (kind in ('general','icu','emergency','ambulance')),
  total integer not null check (total between 0 and 10000),
  free integer not null check (free >= 0 and free <= total),
  verified_at timestamptz, primary key (hospital_id, kind)
);
create table public.sl_requests (
  id uuid primary key default gen_random_uuid(),
  hospital_id uuid not null references public.sl_hospitals,
  requester_id uuid not null references auth.users,
  kind text not null check (kind in ('bed','ambulance','both')),
  bed_type text check (bed_type in ('general','icu','emergency')),
  pickup text not null default '' check (length(pickup) <= 300),
  contact text not null check (contact ~ '^\+?[0-9]{7,15}$'),
  status text not null default 'pending' check (status in ('pending','accepted','en_route','arrived','declined','cancelled','expired')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  hold_until timestamptz, eta_minutes integer check (eta_minutes between 1 and 180),
  check ((kind = 'ambulance' and bed_type is null) or (kind in ('bed','both') and bed_type is not null)),
  check (kind = 'bed' or length(trim(pickup)) >= 5)
);
create index sl_requests_hospital on public.sl_requests(hospital_id,status);
create index sl_requests_requester on public.sl_requests(requester_id,created_at);
create table public.sl_activity (
  id bigint generated always as identity primary key,
  hospital_id uuid not null references public.sl_hospitals,
  actor_id uuid references auth.users, message text not null, created_at timestamptz not null default now()
);
alter table public.sl_hospitals enable row level security;
alter table public.sl_staff enable row level security;
alter table public.sl_staff_invites enable row level security;
alter table public.sl_capacity enable row level security;
alter table public.sl_requests enable row level security;
alter table public.sl_activity enable row level security;
-- Tables are intentionally inaccessible through direct REST writes. All access
-- goes through checked RPCs; membership can only be assigned by the project owner.
revoke all on public.sl_hospitals,public.sl_staff,public.sl_capacity,public.sl_requests,public.sl_activity from anon,authenticated;
revoke all on public.sl_staff_invites from anon,authenticated;

create function public.sl_is_staff(p_hospital uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.sl_staff where hospital_id=p_hospital and user_id=auth.uid())
    or exists(select 1 from public.sl_staff_invites i join auth.users u on lower(u.email)=i.email
      where i.hospital_id=p_hospital and u.id=auth.uid() and u.email_confirmed_at is not null);
$$;
create function public.sl_expire(p_hospital uuid) returns void
language sql security definer set search_path = '' as $$
  update public.sl_requests set status='expired',updated_at=now()
  where hospital_id=p_hospital and status='accepted' and hold_until<=now();
$$;
create function public.sl_reserved(p_hospital uuid,p_kind text) returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::integer from public.sl_requests where hospital_id=p_hospital
    and (status='en_route' or (status='accepted' and hold_until>now()))
    and ((p_kind='ambulance' and kind in ('ambulance','both')) or (p_kind<>'ambulance' and bed_type=p_kind));
$$;
create function public.sl_my_hospitals() returns setof public.sl_hospitals
language sql stable security definer set search_path = '' as $$
  select h.* from public.sl_hospitals h where public.sl_is_staff(h.id) order by h.name;
$$;
create function public.sl_directory() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',h.id,'name',h.name,'city',h.city,
    'capacity',(select coalesce(jsonb_agg(jsonb_build_object('kind',c.kind,'available',c.free-public.sl_reserved(h.id,c.kind),'verified_at',c.verified_at)),'[]') from public.sl_capacity c where c.hospital_id=h.id)) order by h.name),'[]')
  from public.sl_hospitals h where h.active;
$$;
create function public.sl_staff_snapshot(p_hospital uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.sl_is_staff(p_hospital) then raise exception 'Staff access required'; end if;
  perform 1 from public.sl_hospitals where id=p_hospital for update;
  perform public.sl_expire(p_hospital);
  return jsonb_build_object('server_time',now(),
    'capacity',(select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('held',public.sl_reserved(p_hospital,c.kind)) order by c.kind),'[]') from public.sl_capacity c where hospital_id=p_hospital),
    'requests',(select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at),'[]') from public.sl_requests r where hospital_id=p_hospital and status in ('pending','accepted','en_route')),
    'activity',(select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc),'[]') from (select message,created_at from public.sl_activity where hospital_id=p_hospital order by created_at desc limit 12) a));
end;
$$;
create function public.sl_adjust_capacity(p_hospital uuid,p_kind text,p_delta integer) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.sl_capacity;
begin
  if not public.sl_is_staff(p_hospital) then raise exception 'Staff access required'; end if;
  if p_delta not in (-1,1) or p_delta is null then raise exception 'Invalid adjustment'; end if;
  perform 1 from public.sl_hospitals where id=p_hospital for update;
  perform public.sl_expire(p_hospital);
  select * into c from public.sl_capacity where hospital_id=p_hospital and kind=p_kind for update;
  if not found then raise exception 'Capacity not configured'; end if;
  if c.free+p_delta < public.sl_reserved(p_hospital,p_kind) or c.free+p_delta>c.total then raise exception 'Count must cover active holds and stay within total capacity'; end if;
  update public.sl_capacity set free=free+p_delta,verified_at=now() where hospital_id=p_hospital and kind=p_kind;
  insert into public.sl_activity(hospital_id,actor_id,message) values(p_hospital,auth.uid(),p_kind||' free capacity updated to '||(c.free+p_delta));
end;
$$;
create function public.sl_confirm_capacity(p_hospital uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.sl_is_staff(p_hospital) then raise exception 'Staff access required'; end if;
  perform 1 from public.sl_hospitals where id=p_hospital for update;
  update public.sl_capacity set verified_at=now() where hospital_id=p_hospital;
  insert into public.sl_activity(hospital_id,actor_id,message) values(p_hospital,auth.uid(),'Capacity counts confirmed');
end;
$$;
create function public.sl_create_request(p_hospital uuid,p_kind text,p_bed text,p_pickup text,p_contact text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare result uuid;
begin
  if auth.uid() is null then raise exception 'Sign in before requesting care'; end if;
  -- Serialize requests per user for the application rate limit.
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
  if (select count(*) from public.sl_requests where requester_id=auth.uid() and created_at>now()-interval '1 hour')>=5 then raise exception 'Request limit reached. Contact the hospital directly.'; end if;
  perform 1 from public.sl_hospitals where id=p_hospital and active for update;
  if not found then raise exception 'Hospital is not accepting online requests'; end if;
  if exists(select 1 from public.sl_requests where requester_id=auth.uid() and hospital_id=p_hospital and (status in ('pending','en_route') or (status='accepted' and hold_until>now()))) then raise exception 'You already have an active request at this hospital'; end if;
  insert into public.sl_requests(hospital_id,requester_id,kind,bed_type,pickup,contact)
    values(p_hospital,auth.uid(),p_kind,p_bed,trim(coalesce(p_pickup,'')),trim(p_contact)) returning id into result;
  insert into public.sl_activity(hospital_id,actor_id,message) values(p_hospital,auth.uid(),'New request '||left(result::text,8));
  return result;
end;
$$;
create function public.sl_respond(p_request uuid,p_action text,p_eta integer default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.sl_requests; h uuid; k text; c public.sl_capacity; next_status text;
begin
  select hospital_id into h from public.sl_requests where id=p_request;
  if not public.sl_is_staff(h) then raise exception 'Staff access required'; end if;
  -- All mutations lock the hospital first, preventing oversubscription/deadlocks.
  perform 1 from public.sl_hospitals where id=h for update;
  perform public.sl_expire(h);
  select * into r from public.sl_requests where id=p_request for update;
  if p_action='accept' and r.status='pending' then
    if p_eta is null or p_eta not between 1 and 180 then raise exception 'Enter an expected arrival between 1 and 180 minutes'; end if;
    foreach k in array array[r.bed_type,case when r.kind in ('ambulance','both') then 'ambulance' end] loop
      if k is not null then
        select * into c from public.sl_capacity where hospital_id=h and kind=k;
        if not found then raise exception 'Required capacity is not configured'; end if;
        if c.verified_at is null or c.verified_at<now()-interval '30 minutes' then raise exception 'Confirm current capacity before accepting'; end if;
        if c.free-public.sl_reserved(h,k)<1 then raise exception 'Requested capacity is no longer available'; end if;
      end if;
    end loop;
    next_status:='accepted';
  elsif p_action='decline' and r.status='pending' then next_status:='declined';
  elsif p_action='dispatch' and r.status='accepted' and r.kind in ('ambulance','both') then next_status:='en_route';
  elsif p_action='arrive' and (r.status='en_route' or (r.status='accepted' and r.kind='bed')) then
    next_status:='arrived';
    update public.sl_capacity set free=free-1,verified_at=now() where hospital_id=h
      and (kind=r.bed_type or (kind='ambulance' and r.kind in ('ambulance','both')));
  elsif p_action='cancel' and r.status in ('accepted','en_route') then
    next_status:='cancelled';
    -- An already dispatched vehicle remains unavailable until staff returns it.
    if r.status='en_route' then update public.sl_capacity set free=free-1,verified_at=now() where hospital_id=h and kind='ambulance'; end if;
  else raise exception 'Request changed. Refresh before acting.';
  end if;
  update public.sl_requests set status=next_status,updated_at=now(),
    hold_until=case when next_status='accepted' then now()+interval '20 minutes' else hold_until end,
    eta_minutes=case when next_status='accepted' then p_eta else eta_minutes end where id=p_request;
  insert into public.sl_activity(hospital_id,actor_id,message) values(h,auth.uid(),'Request '||left(p_request::text,8)||' · '||next_status);
end;
$$;
create function public.sl_my_requests() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('hospital_name',h.name,'status',case when r.status='accepted' and r.hold_until<=now() then 'expired' else r.status end) order by r.created_at desc),'[]')
  from (select * from public.sl_requests where requester_id=auth.uid() order by created_at desc limit 30) r join public.sl_hospitals h on h.id=r.hospital_id;
$$;
create function public.sl_cancel_request(p_request uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare h uuid;
begin
  select hospital_id into h from public.sl_requests where id=p_request and requester_id=auth.uid();
  if h is null then raise exception 'Request not found'; end if;
  perform 1 from public.sl_hospitals where id=h for update;
  update public.sl_requests set status='cancelled',updated_at=now() where id=p_request and requester_id=auth.uid() and status in ('pending','accepted');
  if not found then raise exception 'Contact the hospital to change a dispatched request'; end if;
  insert into public.sl_activity(hospital_id,actor_id,message) values(h,auth.uid(),'Request '||left(p_request::text,8)||' cancelled by requester');
end;
$$;
-- Explicit grants, including revocation of PostgreSQL's default PUBLIC execute.
create function public.sl_set_capacity(p_hospital uuid,p_kind text,p_total integer,p_free integer,p_expected timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.sl_capacity;
begin
  if not public.sl_is_staff(p_hospital) then raise exception 'Staff access required'; end if;
  perform 1 from public.sl_hospitals where id=p_hospital for update;
  select * into c from public.sl_capacity where hospital_id=p_hospital and kind=p_kind for update;
  if not found then raise exception 'Capacity not configured'; end if;
  if c.verified_at is distinct from p_expected then raise exception 'Another staff member changed these counts. Refresh and try again.'; end if;
  if p_total is null or p_free is null or p_total not between 0 and 10000 or p_free<public.sl_reserved(p_hospital,p_kind) or p_free>p_total then raise exception 'Counts must be within total capacity and cover active holds'; end if;
  update public.sl_capacity set total=p_total,free=p_free,verified_at=now() where hospital_id=p_hospital and kind=p_kind;
  insert into public.sl_activity(hospital_id,actor_id,message) values(p_hospital,auth.uid(),p_kind||' capacity confirmed: '||p_free||' free / '||p_total||' total');
end;
$$;
revoke all on function public.sl_set_capacity(uuid,text,integer,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.sl_set_capacity(uuid,text,integer,integer,timestamptz) to authenticated;
revoke all on function public.sl_is_staff(uuid),public.sl_expire(uuid),public.sl_reserved(uuid,text),public.sl_my_hospitals(),public.sl_directory(),public.sl_staff_snapshot(uuid),public.sl_adjust_capacity(uuid,text,integer),public.sl_confirm_capacity(uuid),public.sl_create_request(uuid,text,text,text,text),public.sl_respond(uuid,text,integer),public.sl_my_requests(),public.sl_cancel_request(uuid) from public,anon,authenticated;
grant execute on function public.sl_directory() to anon,authenticated;
grant execute on function public.sl_my_hospitals(),public.sl_staff_snapshot(uuid),public.sl_adjust_capacity(uuid,text,integer),public.sl_confirm_capacity(uuid),public.sl_create_request(uuid,text,text,text,text),public.sl_respond(uuid,text,integer),public.sl_my_requests(),public.sl_cancel_request(uuid) to authenticated;
commit;
