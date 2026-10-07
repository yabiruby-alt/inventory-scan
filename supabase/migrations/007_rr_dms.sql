-- RR DMS 재고 조회
--   BMW DMS 데몬과 따로 RR DMS 데몬이 켜져 있음. RR 데몬은 RR 조회(kind 'rr')만 처리하고,
--   BMW 현재고·재고조사 목록은 건드리지 않음.

-- 데몬 계정이 어느 DMS 것인지
alter table public.inv_daemons add column dms text not null default 'bmw' check (dms in ('bmw', 'rr'));

create function public.inv_daemon_dms() returns text
language sql stable security definer set search_path = public as $$
  select dms from public.inv_daemons where user_id = auth.uid()
$$;
revoke execute on function public.inv_daemon_dms() from public, anon;
grant execute on function public.inv_daemon_dms() to authenticated;

-- RR 데몬 마지막 응답 시각
alter table public.inv_status add column rr_seen_at timestamptz;

-- 요청 종류에 RR 조회 추가
alter table public.inv_requests drop constraint inv_requests_kind_check;
alter table public.inv_requests add constraint inv_requests_kind_check check (kind in ('rdc', 'loc_change', 'stock', 'rr'));

-- 데몬은 자기 DMS 요청만 봄 (BMW 데몬: rr 말고 전부 / RR 데몬: rr 만)
alter policy "데몬 조회" on public.inv_requests
  using (branch = public.inv_daemon_branch() and (kind = 'rr') = (public.inv_daemon_dms() = 'rr'));
alter policy "데몬 처리" on public.inv_requests
  using (branch = public.inv_daemon_branch() and (kind = 'rr') = (public.inv_daemon_dms() = 'rr'))
  with check (branch = public.inv_daemon_branch() and (kind = 'rr') = (public.inv_daemon_dms() = 'rr'));

-- BMW 현재고·재고조사 목록은 BMW 데몬만 씀
alter policy "데몬 쓰기" on public.inv_parts
  using (branch = public.inv_daemon_branch() and public.inv_daemon_dms() = 'bmw')
  with check (branch = public.inv_daemon_branch() and public.inv_daemon_dms() = 'bmw');
alter policy "데몬 쓰기" on public.inv_audit_source
  using (branch = public.inv_daemon_branch() and public.inv_daemon_dms() = 'bmw')
  with check (branch = public.inv_daemon_branch() and public.inv_daemon_dms() = 'bmw');
