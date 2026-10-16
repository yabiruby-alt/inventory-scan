-- 위치 변경 멈춤을 앱에 알리고, 관리자가 앱에서 다시 켤 수 있게 (2026-10-16)
--   데몬이 안전장치로 위치 변경을 멈추면(LOC_CHANGE_HALT.txt) 사유·시각을 inv_status 에 올림 → 앱 전 화면에 띠로 표시
--   관리자(master·admin)는 앱에서 'loc_resume' 요청을 보내 다시 켤 수 있음 (데몬이 멈춤 파일을 이력에 남기고 지움)

alter table public.inv_status
  add column loc_halt    text,          -- 멈춘 사유 (null = 정상)
  add column loc_halt_at timestamptz;

alter table public.inv_requests drop constraint inv_requests_kind_check;
alter table public.inv_requests add constraint inv_requests_kind_check
  check (kind in ('rdc', 'loc_change', 'stock', 'rr', 'loc_resume'));

-- 다시 켜기는 관리자만
drop policy "직원 등록" on public.inv_requests;
create policy "직원 등록" on public.inv_requests for insert to authenticated
  with check (branch = public.inv_user_branch() and requested_by = (select auth.uid()) and status = 'pending'
              and (kind <> 'loc_resume' or public.my_role() in ('master', 'admin')));
