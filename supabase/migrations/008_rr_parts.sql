-- RR 재고도 BMW 처럼: RR 데몬이 10분마다 RR DMS 부품창고 현재고를 올리고, 앱은 바로 보여 줌 (조회 버튼 없음)

create table public.inv_rr_parts (
  branch       text not null,
  item_cd      text not null,
  item_nm      text,
  lct_cd       text,
  crt_qty      numeric not null default 0,
  alois_cd     text,
  last_purc_dt text,
  updated_at   timestamptz not null default now(),
  primary key (branch, item_cd)
);
alter table public.inv_rr_parts enable row level security;
create policy "직원 조회" on public.inv_rr_parts for select to authenticated using (branch = public.inv_user_branch());
create policy "데몬 쓰기" on public.inv_rr_parts for all to authenticated
  using (branch = public.inv_daemon_branch() and public.inv_daemon_dms() = 'rr')
  with check (branch = public.inv_daemon_branch() and public.inv_daemon_dms() = 'rr');

-- RR 현재고 마지막 업로드 시각
alter table public.inv_status add column rr_parts_at timestamptz;
