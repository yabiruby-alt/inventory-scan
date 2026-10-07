-- 카메라 인식 진단: 휴대폰에서 실제 카메라 장면을 저장해 인식 문제를 분석하기 위한 임시 기록
create table public.inv_scan_diag (
  id          bigint generated always as identity primary key,
  branch      text not null default public.inv_user_branch(),
  created_by  uuid not null default auth.uid() references auth.users(id),
  created_at  timestamptz not null default now(),
  kind        text not null check (kind in ('live', 'photo')),   -- 실시간 장면 / 사진 촬영
  device      text,          -- 브라우저 정보
  info        jsonb,         -- 엔진, 해상도, 줌, 안내 칸, 인식 결과 등
  image_jpeg  text           -- base64 JPEG (긴 변 최대 2000px)
);
create index inv_scan_diag_created_idx on public.inv_scan_diag (branch, created_at desc);
create index inv_scan_diag_user_idx on public.inv_scan_diag (created_by);
alter table public.inv_scan_diag enable row level security;
create policy "직원 등록" on public.inv_scan_diag for insert to authenticated
  with check (branch = public.inv_user_branch() and created_by = (select auth.uid()));
create policy "직원 조회" on public.inv_scan_diag for select to authenticated using (branch = public.inv_user_branch());
