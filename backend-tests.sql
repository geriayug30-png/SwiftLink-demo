-- Integration checks against PostgreSQL; all fixtures are rolled back.
begin;
insert into auth.users(id,email,email_confirmed_at) values
 ('00000000-0000-4000-8000-000000000001','staff-test@example.invalid',now()),
 ('00000000-0000-4000-8000-000000000002','patient-test@example.invalid',now()),
 ('00000000-0000-4000-8000-000000000003','other-test@example.invalid',now());
insert into public.sl_hospitals(id,name,city,active) values('00000000-0000-4000-8000-000000000010','Temporary test hospital','Test',true);
insert into public.sl_staff values('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001');
insert into public.sl_capacity(hospital_id,kind,total,free,verified_at)
 select '00000000-0000-4000-8000-000000000010'::uuid,k,1,1,now() from unnest(array['general','icu','emergency','ambulance']) k;
do $$
declare h uuid:='00000000-0000-4000-8000-000000000010'; a uuid; b uuid; failed boolean; n integer;
begin
  if has_table_privilege('anon','public.sl_requests','select') or has_table_privilege('authenticated','public.sl_requests','update') then raise exception 'Direct table privilege leak'; end if;
  if has_function_privilege('anon','public.sl_respond(uuid,text,integer)','execute') or has_function_privilege('authenticated','public.sl_expire(uuid)','execute') then raise exception 'Function privilege leak'; end if;
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
  failed:=false;begin perform public.sl_staff_snapshot(h);exception when others then failed:=true;end;
  if not failed then raise exception 'Patient can read staff data'; end if;
  a:=public.sl_create_request(h,'both','icu','Test landmark only','+910000000000');
  failed:=false;begin perform public.sl_create_request(h,'bed','general','','+910000000000');exception when others then failed:=true;end;
  if not failed then raise exception 'Duplicate active request accepted'; end if;
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',true);
  if jsonb_array_length(public.sl_my_requests())<>0 then raise exception 'Cross-patient request leak'; end if;
  failed:=false;begin perform public.sl_cancel_request(a);exception when others then failed:=true;end;
  if not failed then raise exception 'Cross-patient cancellation allowed'; end if;
  b:=public.sl_create_request(h,'both','icu','Another test landmark','+910000000001');
  failed:=false;begin perform public.sl_respond(a,'accept',12);exception when others then failed:=true;end;
  if not failed then raise exception 'Non-staff can accept'; end if;
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
  perform public.sl_respond(a,'accept',12);
  if public.sl_reserved(h,'icu')<>1 or public.sl_reserved(h,'ambulance')<>1 then raise exception 'Capacity was not reserved'; end if;
  failed:=false;begin perform public.sl_respond(b,'accept',15);exception when others then failed:=true;end;
  if not failed then raise exception 'Overbooking allowed'; end if;
  failed:=false;begin perform public.sl_adjust_capacity(h,'icu',-1);exception when others then failed:=true;end;
  if not failed then raise exception 'Free count reduced below held count'; end if;
  update public.sl_requests set hold_until=now()-interval '1 second' where id=a;
  perform public.sl_staff_snapshot(h);
  if public.sl_reserved(h,'icu')<>0 then raise exception 'Expired hold not released'; end if;
  perform public.sl_respond(b,'accept',15);
  perform public.sl_respond(b,'dispatch',null);
  update public.sl_requests set hold_until=now()-interval '1 second' where id=b;
  perform public.sl_staff_snapshot(h);
  if public.sl_reserved(h,'icu')<>1 then raise exception 'Dispatched hold expired unexpectedly'; end if;
  perform public.sl_respond(b,'arrive',null);
  select free into n from public.sl_capacity where hospital_id=h and kind='icu';
  if n<>0 then raise exception 'Arrival did not occupy bed'; end if;
  select free into n from public.sl_capacity where hospital_id=h and kind='ambulance';
  if n<>0 then raise exception 'Vehicle returned prematurely'; end if;
  failed:=false;begin perform public.sl_respond(b,'arrive',null);exception when others then failed:=true;end;
  if not failed then raise exception 'Duplicate arrival allowed'; end if;
  failed:=false;begin perform public.sl_set_capacity(h,'icu',1,1,null);exception when others then failed:=true;end;
  if not failed then raise exception 'Stale capacity edit allowed'; end if;
  perform public.sl_adjust_capacity(h,'icu',1);
  failed:=false;begin perform public.sl_adjust_capacity(h,'icu',1);exception when others then failed:=true;end;
  if not failed then raise exception 'Count above total allowed'; end if;
  -- Email allowlist does not grant access until the email has been verified.
  insert into public.sl_staff_invites values(h,'other-test@example.invalid');
  update auth.users set email_confirmed_at=null where id='00000000-0000-4000-8000-000000000003';
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',true);
  if public.sl_is_staff(h) then raise exception 'Unverified email obtained staff access'; end if;
end $$;
rollback;
select 'PASS: access isolation, verification, duplicates, capacity limits, expiry, dispatch, arrival, stale edits' as result;
