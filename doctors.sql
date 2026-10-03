begin;
create table if not exists public.sl_doctors (
 hospital_id uuid references public.sl_hospitals(id) on delete cascade,
 specialty text check(length(specialty) between 2 and 80),
 total integer not null check(total between 0 and 10000),
 available integer not null check(available between 0 and total),
 verified_at timestamptz not null default now(),
 primary key(hospital_id,specialty)
);
alter table public.sl_doctors enable row level security;
revoke all on public.sl_doctors from anon,authenticated;
create or replace function public.sl_doctor_directory() returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(d) order by d.specialty),'[]') from public.sl_doctors d
 join public.sl_hospitals h on h.id=d.hospital_id where h.active;
$$;
create or replace function public.sl_set_doctors(p_hospital uuid,p_specialty text,p_total integer,p_available integer,p_expected timestamptz) returns void
language plpgsql security definer set search_path='' as $$
declare previous timestamptz; specialty_name text:=trim(p_specialty);
begin
 if not public.sl_is_staff(p_hospital) then raise exception 'Staff access required'; end if;
 if specialty_name is null or length(specialty_name) not between 2 and 80 or p_total is null or p_total not between 0 and 10000 or p_available is null or p_available<0 or p_available>p_total then raise exception 'Enter a specialty and valid doctor counts'; end if;
 perform 1 from public.sl_hospitals where id=p_hospital for update;
 select verified_at into previous from public.sl_doctors where hospital_id=p_hospital and specialty=specialty_name;
 if previous is distinct from p_expected then raise exception 'Another staff member updated this specialty. Refresh and try again.'; end if;
 insert into public.sl_doctors(hospital_id,specialty,total,available) values(p_hospital,specialty_name,p_total,p_available)
 on conflict(hospital_id,specialty) do update set total=excluded.total,available=excluded.available,verified_at=now();
 insert into public.sl_activity(hospital_id,actor_id,message) values(p_hospital,auth.uid(),specialty_name||' doctors: '||p_available||' available / '||p_total||' total');
end;
$$;
revoke all on function public.sl_doctor_directory(),public.sl_set_doctors(uuid,text,integer,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.sl_doctor_directory() to anon,authenticated;
grant execute on function public.sl_set_doctors(uuid,text,integer,integer,timestamptz) to authenticated;
commit;
