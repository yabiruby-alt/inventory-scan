-- 재고조사 앱 (inventory-scan) 테이블
-- 같은 Supabase 프로젝트를 쓰는 태블릿 입출고 앱의 테이블(profiles 등)은 읽기만 하고 바꾸지 않는다.
-- 모든 테이블 이름은 inv_ 로 시작한다.

-- ------------------------------------------------------------
-- 권한 확인 함수
-- ------------------------------------------------------------

-- 데몬 전용 계정 목록 (profiles 에 넣지 않아 태블릿 앱 계정 목록에 보이지 않음)
create table public.inv_daemons (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  branch     text not null,
  created_at timestamptz not null default now()
);
alter table public.inv_daemons enable row level security;
-- 정책 없음: 앱·데몬 모두 직접 읽거나 쓸 수 없고, 아래 함수로만 확인

-- 로그인한 직원의 지점 (사용 중인 계정만)
create function public.inv_user_branch() returns text
language sql stable security definer set search_path = public as $$
  select branch from public.profiles where id = auth.uid() and active
$$;

-- 로그인한 직원의 이름 (기록에 남길 이름)
create function public.inv_user_name() returns text
language sql stable security definer set search_path = public as $$
  select name from public.profiles where id = auth.uid() and active
$$;

-- 로그인한 데몬 계정의 지점
create function public.inv_daemon_branch() returns text
language sql stable security definer set search_path = public as $$
  select branch from public.inv_daemons where user_id = auth.uid()
$$;

revoke execute on function public.inv_user_branch(), public.inv_user_name(), public.inv_daemon_branch() from public, anon;
grant execute on function public.inv_user_branch(), public.inv_user_name(), public.inv_daemon_branch() to authenticated;

-- ------------------------------------------------------------
-- 데몬이 10분마다 올리는 데이터
-- ------------------------------------------------------------

-- 부품창고 현재고 (DMS 현재고리스트, Z 코드 제외)
create table public.inv_parts (
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
create index inv_parts_loc_idx on public.inv_parts (branch, lct_cd);

-- 데몬 상태 (마지막 재고 갱신 시각, 마지막 응답 시각)
create table public.inv_status (
  branch         text primary key,
  parts_at       timestamptz,
  lists_at       timestamptz,
  daemon_seen_at timestamptz
);

-- 재고조사 원본 목록 (데몬의 일일·주간 목록 최신본)
create table public.inv_audit_source (
  branch       text not null,
  kind         text not null check (kind in ('daily', 'weekly')),
  period_start date not null,
  period_end   date not null,
  items        jsonb not null default '[]'::jsonb,  -- [{item_cd, item_nm, lct_cd, qty, alois_cd}]
  updated_at   timestamptz not null default now(),
  primary key (branch, kind)
);

-- ------------------------------------------------------------
-- 앱 → 데몬 요청 (RDC 재고 조회, DMS 위치 변경, 현재고 새로 조회)
-- ------------------------------------------------------------
create table public.inv_requests (
  id                bigint generated always as identity primary key,
  branch            text not null default public.inv_user_branch(),
  kind              text not null check (kind in ('rdc', 'loc_change', 'stock')),
  item_cd           text not null,
  params            jsonb not null default '{}'::jsonb,   -- loc_change: {from, to}
  status            text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  result            jsonb,
  error             text,
  requested_by      uuid not null default auth.uid() references auth.users(id),
  requested_by_name text default public.inv_user_name(),
  requested_at      timestamptz not null default now(),
  started_at        timestamptz,
  finished_at       timestamptz
);
create index inv_requests_pending_idx on public.inv_requests (branch, status, requested_at);

-- ------------------------------------------------------------
-- 수량 다름 체크 기록
-- ------------------------------------------------------------
create table public.inv_checks (
  id              bigint generated always as identity primary key,
  branch          text not null default public.inv_user_branch(),
  item_cd         text not null,
  item_nm         text,
  lct_cd          text,
  dms_qty         numeric not null,
  counted_qty     numeric not null,
  memo            text,
  audit_id        uuid,
  checked_by      uuid not null default auth.uid() references auth.users(id),
  checked_by_name text default public.inv_user_name(),
  checked_at      timestamptz not null default now(),
  cleared_at      timestamptz,             -- 재고 정정 후 기록 지움
  cleared_by_name text
);
create index inv_checks_open_idx on public.inv_checks (branch, cleared_at, checked_at desc);

-- ------------------------------------------------------------
-- 재고조사 (조사 시작 시점에 목록 고정)
-- ------------------------------------------------------------
create table public.inv_audits (
  id              uuid primary key default gen_random_uuid(),
  branch          text not null,
  kind            text not null check (kind in ('daily', 'weekly')),
  period_start    date not null,
  period_end      date not null,
  item_count      int not null,
  started_by      uuid not null references auth.users(id),
  started_by_name text,
  started_at      timestamptz not null default now()
);
create index inv_audits_branch_idx on public.inv_audits (branch, kind, started_at desc);

create table public.inv_audit_items (
  audit_id        uuid not null references public.inv_audits(id) on delete cascade,
  item_cd         text not null,
  item_nm         text,
  lct_cd          text,
  qty             numeric not null,         -- 조사 시작 시점의 DMS 현재고
  status          text check (status in ('ok', 'diff')),
  counted         numeric,
  memo            text,
  checked_by      uuid references auth.users(id),
  checked_by_name text,
  checked_at      timestamptz,
  primary key (audit_id, item_cd)
);

alter table public.inv_checks
  add constraint inv_checks_audit_fk foreign key (audit_id) references public.inv_audits(id) on delete set null;

-- 조사 시작: 데몬이 올린 최신 목록을 그대로 복사해 고정
create function public.inv_start_audit(p_kind text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_branch text := public.inv_user_branch();
  v_src    public.inv_audit_source;
  v_id     uuid;
begin
  if v_branch is null then
    raise exception '로그인한 직원 계정이 아닙니다';
  end if;
  select * into v_src from public.inv_audit_source where branch = v_branch and kind = p_kind;
  if not found then
    raise exception '조사 목록이 아직 없습니다';
  end if;
  insert into public.inv_audits (branch, kind, period_start, period_end, item_count, started_by, started_by_name)
  values (v_branch, p_kind, v_src.period_start, v_src.period_end, jsonb_array_length(v_src.items), auth.uid(), public.inv_user_name())
  returning id into v_id;
  insert into public.inv_audit_items (audit_id, item_cd, item_nm, lct_cd, qty)
  select v_id, x->>'item_cd', x->>'item_nm', x->>'lct_cd', (x->>'qty')::numeric
  from jsonb_array_elements(v_src.items) x;
  return v_id;
end;
$$;
revoke execute on function public.inv_start_audit(text) from public, anon;
grant execute on function public.inv_start_audit(text) to authenticated;

-- ------------------------------------------------------------
-- 행 단위 권한 (RLS): 직원은 자기 지점만, 데몬은 자기 지점 데이터만 쓰기
-- ------------------------------------------------------------
alter table public.inv_parts        enable row level security;
alter table public.inv_status       enable row level security;
alter table public.inv_audit_source enable row level security;
alter table public.inv_requests     enable row level security;
alter table public.inv_checks       enable row level security;
alter table public.inv_audits       enable row level security;
alter table public.inv_audit_items  enable row level security;

-- 현재고·상태·조사 원본: 직원 읽기, 데몬 쓰기
create policy "직원 조회" on public.inv_parts for select to authenticated using (branch = public.inv_user_branch());
create policy "데몬 쓰기" on public.inv_parts for all to authenticated
  using (branch = public.inv_daemon_branch()) with check (branch = public.inv_daemon_branch());

create policy "직원 조회" on public.inv_status for select to authenticated using (branch = public.inv_user_branch());
create policy "데몬 쓰기" on public.inv_status for all to authenticated
  using (branch = public.inv_daemon_branch()) with check (branch = public.inv_daemon_branch());

create policy "직원 조회" on public.inv_audit_source for select to authenticated using (branch = public.inv_user_branch());
create policy "데몬 쓰기" on public.inv_audit_source for all to authenticated
  using (branch = public.inv_daemon_branch()) with check (branch = public.inv_daemon_branch());

-- 요청: 직원은 자기 이름으로 대기 요청만 등록, 데몬은 처리 결과 기록
create policy "직원 조회" on public.inv_requests for select to authenticated using (branch = public.inv_user_branch());
create policy "직원 등록" on public.inv_requests for insert to authenticated
  with check (branch = public.inv_user_branch() and requested_by = auth.uid() and status = 'pending');
create policy "데몬 조회" on public.inv_requests for select to authenticated using (branch = public.inv_daemon_branch());
create policy "데몬 처리" on public.inv_requests for update to authenticated
  using (branch = public.inv_daemon_branch()) with check (branch = public.inv_daemon_branch());

-- 체크 기록: 같은 지점 직원끼리 공유
create policy "직원 조회" on public.inv_checks for select to authenticated using (branch = public.inv_user_branch());
create policy "직원 등록" on public.inv_checks for insert to authenticated
  with check (branch = public.inv_user_branch() and checked_by = auth.uid());
create policy "직원 수정" on public.inv_checks for update to authenticated
  using (branch = public.inv_user_branch()) with check (branch = public.inv_user_branch());

-- 재고조사: 시작은 inv_start_audit() 으로만, 항목 확인은 같은 지점 직원 누구나
create policy "직원 조회" on public.inv_audits for select to authenticated using (branch = public.inv_user_branch());
create policy "직원 조회" on public.inv_audit_items for select to authenticated
  using (exists (select 1 from public.inv_audits a where a.id = audit_id and a.branch = public.inv_user_branch()));
create policy "직원 확인" on public.inv_audit_items for update to authenticated
  using (exists (select 1 from public.inv_audits a where a.id = audit_id and a.branch = public.inv_user_branch()))
  with check (exists (select 1 from public.inv_audits a where a.id = audit_id and a.branch = public.inv_user_branch()));

-- 직원 이름 칸은 서버가 채움 (다른 사람 이름으로 기록하지 못하게)
create function public.inv_stamp_checker() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status or new.counted is distinct from old.counted then
    new.checked_by := auth.uid();
    new.checked_by_name := public.inv_user_name();
    new.checked_at := now();
  end if;
  return new;
end;
$$;
create trigger inv_audit_items_stamp before update on public.inv_audit_items
  for each row execute function public.inv_stamp_checker();

create function public.inv_stamp_request() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.requested_by_name := public.inv_user_name();
  return new;
end;
$$;
create trigger inv_requests_stamp before insert on public.inv_requests
  for each row execute function public.inv_stamp_request();

create function public.inv_stamp_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.checked_by_name := public.inv_user_name();
  return new;
end;
$$;
create trigger inv_checks_stamp before insert on public.inv_checks
  for each row execute function public.inv_stamp_check();

-- 실시간 반영 (여러 명이 같은 조사를 할 때, 요청 처리 결과를 바로 받을 때)
alter publication supabase_realtime add table public.inv_requests, public.inv_audit_items, public.inv_checks;
