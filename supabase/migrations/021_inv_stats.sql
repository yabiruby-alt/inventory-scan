-- 재고 관리 앱 통계 (통계 대시보드 dsm-stats-dashboard 의 "재고 관리" 메뉴용)
--   결정(2026-10-12): 입출고 통계처럼 사용 중인 모든 로그인 계정이 전 지점·이름까지 볼 수 있다.
--   서버에는 "누가·언제·몇 건·어떤 방식"만 둔다 (부품번호·위치는 통계 표에 올리지 않음).
--   재고 표(inv_parts 등)는 지점별로만 보이므로, 통계는 집계 결과만 돌려주는 함수(security definer)로 읽는다.

-- 1) 앱이 하루 단위로 모아 올리는 건수: 스캔 수 (재고조사 중 / 일반 조회 따로)
create table public.inv_stat_counts (
  device_id  text not null check (char_length(device_id) between 8 and 64),   -- 설치마다 만든 무작위 값
  stat_date  date not null,                                                  -- 한국 날짜
  user_id    uuid not null references auth.users(id),
  user_name  text not null,
  branch     text not null,
  metric     text not null check (metric in ('scan')),
  ctx        text not null check (ctx in ('lookup', 'audit')),               -- 일반 조회(스캔 탭) / 재고조사 중
  target     text not null check (target in ('part', 'loc', 'unknown')),     -- 부품 / 위치 / 목록에 없는 바코드
  via        text not null check (via in ('scanner', 'camera', 'manual')),   -- 블루투스 스캐너 / 카메라 / 직접 입력·검색
  n          integer not null check (n >= 0),
  updated_at timestamptz not null default now(),
  primary key (device_id, stat_date, user_id, metric, ctx, target, via)
);
create index inv_stat_counts_date_idx on public.inv_stat_counts (stat_date, branch);
create index inv_stat_counts_user_idx on public.inv_stat_counts (user_id);
alter table public.inv_stat_counts enable row level security;
create policy "통계 조회" on public.inv_stat_counts for select to authenticated using (public.my_role() is not null);
-- 쓰기는 아래 함수로만

-- 앱이 부름. 그날의 누적 건수를 보내면 덮어씀(같은 걸 다시 보내도 중복 집계 없음, 줄어든 값은 무시)
--   p_rows: [{d:'2026-10-12', metric:'scan', ctx:'lookup', target:'part', via:'scanner', n:12}, ...]
create function public.inv_stat_push(p_device text, p_rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_branch text := public.inv_user_branch();
  v_name   text := public.inv_user_name();
  v_today  date := (now() at time zone 'Asia/Seoul')::date;
  v_n      integer;
begin
  if v_branch is null then
    raise exception '로그인한 직원 계정이 아닙니다';
  end if;
  insert into public.inv_stat_counts (device_id, stat_date, user_id, user_name, branch, metric, ctx, target, via, n)
  select p_device, (x->>'d')::date, auth.uid(), v_name, v_branch, x->>'metric', x->>'ctx', x->>'target', x->>'via', (x->>'n')::integer
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x
   where (x->>'d')::date between v_today - 14 and v_today + 1 and (x->>'n')::integer between 0 and 100000
  on conflict (device_id, stat_date, user_id, metric, ctx, target, via) do update
     set n = greatest(public.inv_stat_counts.n, excluded.n), user_name = excluded.user_name, branch = excluded.branch, updated_at = now();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function public.inv_stat_push(text, jsonb) from public, anon;
grant execute on function public.inv_stat_push(text, jsonb) to authenticated;

-- 2) 일별 건수 (긴 표 한 장). metric 마다 kind·via·result 의 뜻:
--   scan        스캔 수            kind = lookup(일반 조회) | audit(재고조사 중)   via = scanner|camera|manual   result = part|loc|unknown
--   audit_check 재고조사 확인      kind = daily|aging|weekly                       via = scanner|camera|part|exempt|unknown (현장 확인 방식)   result = ok|diff
--   loc_change  위치 변경          kind = '-'   via = '-'   result = done|failed|cancelled|pending
--   rdc         RDC 조회           kind = '-'   via = '-'   result = done|failed|...
--   check       수량 다름 체크     kind = scan(스캔 탭에서) | audit(재고조사에서)   via = '-'   result = open|cleared
create function public.inv_stat_daily(p_from date, p_to date)
returns table (stat_date date, branch text, user_key text, user_name text, metric text, kind text, via text, result text, n integer)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if public.my_role() is null then
    raise exception '사용 중인 계정이 아닙니다';
  end if;
  return query
  select c.stat_date, c.branch, c.user_id::text, max(c.user_name), 'scan'::text, c.ctx, c.via, c.target, sum(c.n)::integer
    from public.inv_stat_counts c
   where c.metric = 'scan' and c.stat_date between p_from and p_to
   group by c.stat_date, c.branch, c.user_id, c.ctx, c.via, c.target
  union all
  select (coalesce(i.marked_at, i.checked_at) at time zone 'Asia/Seoul')::date, a.branch, coalesce(i.checked_by::text, 'name:' || coalesce(i.checked_by_name, '?')),
         max(coalesce(i.checked_by_name, '?')), 'audit_check'::text, a.kind, coalesce(i.loc_via, 'unknown'), i.status, count(*)::integer
    from public.inv_audit_items i join public.inv_audits a on a.id = i.audit_id
   where i.status is not null
     and (coalesce(i.marked_at, i.checked_at) at time zone 'Asia/Seoul')::date between p_from and p_to
   group by 1, a.branch, 3, a.kind, coalesce(i.loc_via, 'unknown'), i.status
  union all
  select (r.requested_at at time zone 'Asia/Seoul')::date, r.branch, coalesce(r.requested_by::text, 'name:' || coalesce(r.requested_by_name, '?')),
         max(coalesce(r.requested_by_name, '?')), r.kind, '-'::text, '-'::text, r.status, count(*)::integer
    from public.inv_requests r
   where r.kind in ('loc_change', 'rdc')
     and (r.requested_at at time zone 'Asia/Seoul')::date between p_from and p_to
   group by 1, r.branch, 3, r.kind, r.status
  union all
  select (k.checked_at at time zone 'Asia/Seoul')::date, k.branch, coalesce(k.checked_by::text, 'name:' || coalesce(k.checked_by_name, '?')),
         max(coalesce(k.checked_by_name, '?')), 'check'::text, case when k.audit_id is null then 'scan' else 'audit' end, '-'::text,
         case when k.cleared_at is null then 'open' else 'cleared' end, count(*)::integer
    from public.inv_checks k
   where (k.checked_at at time zone 'Asia/Seoul')::date between p_from and p_to
   group by 1, k.branch, 3, 6, 8;
end;
$$;

-- 3) 재고조사 작업시간(초): 한 사람의 하루 확인 시각들 사이 간격의 합 (간격이 5분을 넘으면 그 시간은 뺌 — 입출고 통계와 같은 규칙)
create function public.inv_stat_active(p_from date, p_to date)
returns table (stat_date date, branch text, user_key text, user_name text, checks integer, active_sec integer, first_at timestamptz, last_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if public.my_role() is null then
    raise exception '사용 중인 계정이 아닙니다';
  end if;
  return query
  with t as (
    select (coalesce(i.marked_at, i.checked_at) at time zone 'Asia/Seoul')::date as d, a.branch as b,
           coalesce(i.checked_by::text, 'name:' || coalesce(i.checked_by_name, '?')) as uk, coalesce(i.checked_by_name, '?') as un,
           coalesce(i.marked_at, i.checked_at) as at
      from public.inv_audit_items i join public.inv_audits a on a.id = i.audit_id
     where i.status is not null
       and (coalesce(i.marked_at, i.checked_at) at time zone 'Asia/Seoul')::date between p_from and p_to
  ), g as (
    select t.*, extract(epoch from (t.at - lag(t.at) over (partition by t.d, t.b, t.uk order by t.at))) as gap from t
  )
  select g.d, g.b, g.uk, max(g.un), count(*)::integer,
         coalesce(sum(case when g.gap is not null and g.gap <= 300 then g.gap else 0 end), 0)::integer, min(g.at), max(g.at)
    from g group by g.d, g.b, g.uk;
end;
$$;

-- 4) 조사별 요약 (일일재고조사를 누적 며칠 했는지, 완료율 등)
--   kind: daily(일일) | aging(일일장기) | weekly(주간).  period_start = 조사 날짜(주간은 그 주 월요일)
create function public.inv_stat_audits(p_from date, p_to date)
returns table (audit_id uuid, branch text, kind text, period_start date, period_end date,
               started_at timestamptz, started_by_name text, finished_at timestamptz, finished_by_name text,
               total integer, ok integer, diff integer, unchecked integer, exempt integer, removed_zero integer, workers integer)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if public.my_role() is null then
    raise exception '사용 중인 계정이 아닙니다';
  end if;
  return query
  select a.id, a.branch, a.kind, a.period_start, a.period_end, a.started_at, a.started_by_name, a.finished_at, a.finished_by_name,
         count(i.item_cd)::integer,
         count(*) filter (where i.status = 'ok')::integer,
         count(*) filter (where i.status = 'diff')::integer,
         count(*) filter (where i.item_cd is not null and i.status is null)::integer,
         count(*) filter (where i.status is not null and i.loc_via = 'exempt')::integer,
         jsonb_array_length(a.qty_removed)::integer,
         count(distinct i.checked_by) filter (where i.status is not null)::integer
    from public.inv_audits a left join public.inv_audit_items i on i.audit_id = a.id
   where a.period_start between p_from and p_to
   group by a.id;
end;
$$;

revoke execute on function public.inv_stat_daily(date, date), public.inv_stat_active(date, date), public.inv_stat_audits(date, date) from public, anon;
grant execute on function public.inv_stat_daily(date, date), public.inv_stat_active(date, date), public.inv_stat_audits(date, date) to authenticated;

-- 5) RDC 조회 건수를 통계에 쓰므로, 오래된 요청 정리는 자동 실시간 조회(stock)만 지움 (020 고침)
create or replace function public.inv_cleanup_requests(p_days integer default 30) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_branch text := public.inv_daemon_branch();
  v_n      integer;
begin
  if v_branch is null then
    raise exception '데몬 계정이 아닙니다';
  end if;
  delete from public.inv_requests
   where branch = v_branch and kind = 'stock'
     and requested_at < now() - make_interval(days => greatest(p_days, 7));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
