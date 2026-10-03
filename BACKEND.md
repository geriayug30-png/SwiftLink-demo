# Live hospital backend

The patient website remains on GitHub Pages. Supabase hosts email/password authentication, PostgreSQL, and restricted RPC endpoints. The browser receives only a **publishable** API key in `backend-config.js`; never put a secret or service-role key in this repository.

## Provisioning

1. Create a Supabase project. Execute `backend-schema.sql` once as project owner.
2. Set the Auth Site URL to `https://geriayug30-png.github.io/SwiftLink-demo/staff.html`. Allow that URL and `https://geriayug30-png.github.io/SwiftLink-demo/request.html` as redirect URLs.
3. Configure a custom SMTP provider for verification and recovery email. Supabase's default email service is restricted; it is not a public production mail provider. Keep **Confirm email** enabled: staff email assignments require verified ownership. After testing delivery, change `emailDeliveryReady` to `true` in `backend-config.js` and commit it to enable registration. Until then, registration is visibly disabled; existing verified accounts can sign in.
4. Set the project URL and public publishable key in `backend-config.js`.
5. Onboard actual hospitals and staff using the SQL below. Initial counts should be zero/unverified until the hospital confirms capacity. Do not use fictional data as live capacity.

```sql
begin;
-- Replace the hospital details and staff email before executing.
with hospital as (
  insert into public.sl_hospitals(name,city,active)
  values ('YOUR HOSPITAL','YOUR CITY',true) returning id
), capacity as (
  insert into public.sl_capacity(hospital_id,kind,total,free)
  select h.id,k,0,0 from hospital h cross join unnest(array['general','icu','emergency','ambulance']) k
)
insert into public.sl_staff_invites(hospital_id,email)
select id,lower('STAFF_EMAIL') from hospital;
commit;
```

The allowlist is an access assignment, not an email invitation. The staff member creates an account on `staff.html` with the assigned email, verifies their email and signs in. Only the owner can add or remove hospital assignments; patient sign-up never grants staff rights. To revoke access, remove both applicable `sl_staff_invites` and `sl_staff` rows. No roles are derived from user-editable metadata.

## Workflow

- `staff.html`: hospital-scoped capacity controls, incoming requests, expected arrivals, fleet availability and audit history.
- `request.html`: signed-in request creation, private status tracking and cancellation before dispatch. Callback and pickup are disclosed only to that requester and assigned staff via RPCs.
- Accepting requires a fresh capacity confirmation (within 30 minutes), enough beds and vehicles, and a staff-entered arrival estimate. One hospital row lock serializes all inventory mutations and acceptance, avoiding oversubscription. Repeated actions and stale inventory edits are rejected.
- Accepted capacity holds expire after 20 minutes. Availability queries exclude expired holds even without a background job. Staff refresh marks them expired in storage.
- Explicit dispatch keeps capacity reserved until arrival or staff cancellation. Arrival occupies the bed and removes the ambulance from the ready pool. A cancelled dispatched ambulance also remains unavailable. Staff must manually return a vehicle to ready when it is actually available.
- The page polls every 15 seconds while visible and provides manual refresh. These are staff reports, not automatic live tracking or a connection to emergency dispatch.
- New requests are limited to five per user per hour and one active request per hospital. This is not a comprehensive abuse prevention system; configure Auth rate limits/CAPTCHA as appropriate.
- `backend-tests.sql` runs database integration assertions in a transaction and rolls all fixtures back. It tests authorization, cross-patient isolation, email verification, stale edits, double acceptance, capacity limits, expiry, dispatch and arrival.

## Operations

Keep email verification enabled and configure SMTP before inviting users. Do not publish fabricated availability. Confirm hospital ownership, staffing and contact procedures before operational use. The app stores callback numbers and pickup landmarks but does not request diagnoses or medical records. The operator must establish retention/deletion procedures, support contacts and monitoring before handling real patient traffic. No clinical certification or operational readiness is implied by deployment. Free-tier quotas and provider availability apply.

References: [Supabase authentication](https://supabase.com/docs/reference/javascript/auth), [database functions](https://supabase.com/docs/guides/database/functions), [row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security).
