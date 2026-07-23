-- 쉼표 Supabase 보안 정책 / 무결성 설정
-- 실행 위치: Supabase Dashboard > SQL Editor
-- 실행 전 데이터 백업을 권장합니다.

begin;

-- 선택 컬럼을 안전하게 보완합니다.
alter table public.annual_leaves add column if not exists memo text;
alter table public.annual_leaves add column if not exists status text default 'confirmed';

-- upsert 충돌 기준과 사용자별 설정을 보장합니다.
create unique index if not exists annual_leaves_id_uidx
  on public.annual_leaves (id);
create unique index if not exists annual_settings_user_id_uidx
  on public.annual_settings (user_id);
create unique index if not exists holidays_date_uidx
  on public.holidays (date);

-- 값 범위를 DB에서도 검증합니다.
alter table public.annual_leaves drop constraint if exists annual_leaves_date_order_check;
alter table public.annual_leaves add constraint annual_leaves_date_order_check
  check (end_date >= start_date);

alter table public.annual_leaves drop constraint if exists annual_leaves_type_check;
alter table public.annual_leaves add constraint annual_leaves_type_check
  check (type in ('annual', 'amHalf', 'pmHalf', 'quarter', 'etc'));

alter table public.annual_leaves drop constraint if exists annual_leaves_status_check;
alter table public.annual_leaves add constraint annual_leaves_status_check
  check (status in ('confirmed', 'planned'));

alter table public.annual_leaves drop constraint if exists annual_leaves_reason_length_check;
alter table public.annual_leaves add constraint annual_leaves_reason_length_check
  check (char_length(coalesce(reason, '')) <= 120);

alter table public.annual_leaves drop constraint if exists annual_leaves_memo_length_check;
alter table public.annual_leaves add constraint annual_leaves_memo_length_check
  check (char_length(coalesce(memo, '')) <= 200);

alter table public.annual_settings drop constraint if exists annual_settings_total_leave_check;
alter table public.annual_settings add constraint annual_settings_total_leave_check
  check (total_leave >= 0 and total_leave <= 365);

alter table public.holidays drop constraint if exists holidays_name_length_check;
alter table public.holidays add constraint holidays_name_length_check
  check (char_length(coalesce(name, '')) between 1 and 80);

-- RLS 활성화
alter table public.annual_leaves enable row level security;
alter table public.annual_settings enable row level security;
alter table public.holidays enable row level security;

-- 기존 정책 중 하나라도 permissive하면 다른 정책을 우회할 수 있으므로
-- 이 앱이 사용하는 세 테이블의 기존 정책을 모두 제거한 뒤 최소 정책만 재생성합니다.
do $$
declare
  policy_row record;
begin
  for policy_row in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('annual_leaves', 'annual_settings', 'holidays')
  loop
    execute format('drop policy if exists %I on %I.%I',
      policy_row.policyname, policy_row.schemaname, policy_row.tablename);
  end loop;
end $$;

-- 사용자별 연차 정책을 생성합니다.
drop policy if exists "annual_leaves_select_own" on public.annual_leaves;
drop policy if exists "annual_leaves_insert_own" on public.annual_leaves;
drop policy if exists "annual_leaves_update_own" on public.annual_leaves;
drop policy if exists "annual_leaves_delete_own" on public.annual_leaves;

create policy "annual_leaves_select_own"
on public.annual_leaves for select to authenticated
using (auth.uid() = user_id);

create policy "annual_leaves_insert_own"
on public.annual_leaves for insert to authenticated
with check (auth.uid() = user_id);

create policy "annual_leaves_update_own"
on public.annual_leaves for update to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "annual_leaves_delete_own"
on public.annual_leaves for delete to authenticated
using (auth.uid() = user_id);

drop policy if exists "annual_settings_select_own" on public.annual_settings;
drop policy if exists "annual_settings_insert_own" on public.annual_settings;
drop policy if exists "annual_settings_update_own" on public.annual_settings;
drop policy if exists "annual_settings_delete_own" on public.annual_settings;

create policy "annual_settings_select_own"
on public.annual_settings for select to authenticated
using (auth.uid() = user_id);

create policy "annual_settings_insert_own"
on public.annual_settings for insert to authenticated
with check (auth.uid() = user_id);

create policy "annual_settings_update_own"
on public.annual_settings for update to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "annual_settings_delete_own"
on public.annual_settings for delete to authenticated
using (auth.uid() = user_id);

-- 모든 로그인 사용자는 공휴일을 조회할 수 있고,
-- 지정된 관리자 계정만 추가·수정·삭제할 수 있습니다.
drop policy if exists "holidays_select_authenticated" on public.holidays;
drop policy if exists "holidays_insert_admin" on public.holidays;
drop policy if exists "holidays_update_admin" on public.holidays;
drop policy if exists "holidays_delete_admin" on public.holidays;

create policy "holidays_select_authenticated"
on public.holidays for select to authenticated
using (true);

create policy "holidays_insert_admin"
on public.holidays for insert to authenticated
with check (lower(auth.jwt() ->> 'email') = 'hsoo9897@gmail.com');

create policy "holidays_update_admin"
on public.holidays for update to authenticated
using (lower(auth.jwt() ->> 'email') = 'hsoo9897@gmail.com')
with check (lower(auth.jwt() ->> 'email') = 'hsoo9897@gmail.com');

create policy "holidays_delete_admin"
on public.holidays for delete to authenticated
using (lower(auth.jwt() ->> 'email') = 'hsoo9897@gmail.com');

-- 익명 역할의 기존 테이블 권한을 제거하고,
-- RLS 정책을 통과한 로그인 사용자에게만 필요한 최소 권한을 부여합니다.
revoke all on public.annual_leaves from anon;
revoke all on public.annual_settings from anon;
revoke all on public.holidays from anon;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.annual_leaves to authenticated;
grant select, insert, update, delete on public.annual_settings to authenticated;
grant select, insert, update, delete on public.holidays to authenticated;

commit;
