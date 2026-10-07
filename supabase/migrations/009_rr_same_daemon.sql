-- RR 은 별도 데몬이 아니라 같은 파츠베이 데몬(partsbay.py) 안의 RR DMS 창으로 조회함.
--   007 에서 만든 BMW/RR 데몬 구분은 쓰지 않으므로 정책을 원래대로 돌림
--   (inv_daemons.dms 칸·inv_daemon_dms()·inv_status.rr_seen_at 은 남아 있지만 쓰지 않음)

alter policy "데몬 조회" on public.inv_requests using (branch = public.inv_daemon_branch());
alter policy "데몬 처리" on public.inv_requests
  using (branch = public.inv_daemon_branch()) with check (branch = public.inv_daemon_branch());
alter policy "데몬 쓰기" on public.inv_parts
  using (branch = public.inv_daemon_branch()) with check (branch = public.inv_daemon_branch());
alter policy "데몬 쓰기" on public.inv_audit_source
  using (branch = public.inv_daemon_branch()) with check (branch = public.inv_daemon_branch());

-- RR 현재고도 같은 데몬 계정이 올림
alter policy "데몬 쓰기" on public.inv_rr_parts
  using (branch = public.inv_daemon_branch()) with check (branch = public.inv_daemon_branch());

-- RR 현재고를 못 올렸을 때 이유 (RR DMS 로그인 필요 등) — 앱 화면에 표시
alter table public.inv_status add column rr_error text;
