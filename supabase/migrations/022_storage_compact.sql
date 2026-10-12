-- 용량 줄이기 (9개 지점 사용 대비, 2026-10-12 결정: 재고조사 상세는 90일 보관)
--   1) 조사 기간이 90일 지난 재고조사는 부품별 상세(inv_audit_items)를 지우고 통계용 숫자만 남김
--      - 통계(대시보드)는 그대로: 확인 건수 → inv_stat_audit_sum, 작업시간 → inv_stat_active_sum, 조사 요약 → inv_audits.sum_*
--      - 부품별 마지막 확인(일일장기의 180일 제외, 부품 화면 '마지막 재고조사') → inv_last_check (지점·부품당 1줄)
--      - 수량 다름 건은 체크 기록(inv_checks)에 그대로 남음
--   2) 자동 실시간 조회(stock) 기록은 3일, RDC 조회는 7일 뒤 결과 내용만 비움(건수는 통계에 씀), 카메라 진단 사진은 14일
--   데몬이 하루 한 번 부름 (지점마다 자기 지점 것만)

-- 정리한 조사의 확인 건수 (inv_stat_daily 의 audit_check 와 같은 모양)
create table public.inv_stat_audit_sum (
  stat_date date not null,
  branch    text not null,
  user_key  text not null,
  user_name text not null,
  kind      text not null,
  via       text not null,
  result    text not null,
  n         integer not null,
  primary key (stat_date, branch, user_key, kind, via, result)
);
-- 정리한 조사의 작업시간 (하루·사람당 한 줄)
create table public.inv_stat_active_sum (
  stat_date  date not null,
  branch     text not null,
  user_key   text not null,
  user_name  text not null,
  checks     integer not null,
  active_sec integer not null,
  first_at   timestamptz,
  last_at    timestamptz,
  primary key (stat_date, branch, user_key)
);
-- 부품별 마지막 재고조사 확인 (정리한 조사에서 옮겨 둠)
create table public.inv_last_check (
  branch          text not null,
  item_cd         text not null,
  checked_at      timestamptz not null,
  status          text not null,
  counted         numeric,
  qty             numeric,
  rr_qty          numeric,
  checked_by_name text,
  kind            text,
  primary key (branch, item_cd)
);
alter table public.inv_stat_audit_sum enable row level security;
alter table public.inv_stat_active_sum enable row level security;
alter table public.inv_last_check enable row level security;
create policy "통계 조회" on public.inv_stat_audit_sum for select to authenticated using (public.my_role() is not null);
create policy "통계 조회" on public.inv_stat_active_sum for select to authenticated using (public.my_role() is not null);
create policy "직원 조회" on public.inv_last_check for select to authenticated using (branch = public.inv_user_branch());

alter table public.inv_audits
  add column compacted_at  timestamptz,   -- 상세를 정리한 시각 (null = 상세 있음)
  add column sum_total     integer,
  add column sum_ok        integer,
  add column sum_diff      integer,
  add column sum_unchecked integer,
  add column sum_exempt    integer,
  add column sum_removed   integer,
  add column sum_workers   integer;

-- 정리: 데몬이 하루 한 번. 돌려주는 값 = {audits: 정리한 조사 수, items: 지운 상세 줄 수, requests, rdc, diag}
create function public.inv_compact(p_audit_days integer default 90) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_branch text := public.inv_daemon_branch();
  v_days   integer := greatest(coalesce(p_audit_days, 90), 30);
  a        record;
  v_audits integer := 0; v_items integer := 0; v_req integer; v_rdc integer; v_diag integer; v_n integer;
begin
  if v_branch is null then
    raise exception '데몬 계정이 아닙니다';
  end if;

  -- 작업시간은 하루 단위로 굳힘: 정리될 조사에 확인이 있는 날은 그날의 모든 조사 확인을 합쳐 계산(조사를 오가며 한 작업 간격 포함).
  -- 이미 굳힌 날은 건드리지 않음. inv_stat_active 는 굳힌 날이면 이 값을, 아니면 상세에서 계산한 값을 씀
  insert into public.inv_stat_active_sum (stat_date, branch, user_key, user_name, checks, active_sec, first_at, last_at)
  select g.d, v_branch, g.uk, max(g.un), count(*)::integer,
         coalesce(sum(case when g.gap is not null and g.gap <= 300 then g.gap else 0 end), 0)::integer, min(g.at), max(g.at)
    from (
      select t.*, extract(epoch from (t.at - lag(t.at) over (partition by t.d, t.uk order by t.at))) as gap
        from (
          select (coalesce(i.marked_at, i.checked_at) at time zone 'Asia/Seoul')::date as d,
                 coalesce(i.checked_by::text, 'name:' || coalesce(i.checked_by_name, '?')) as uk, coalesce(i.checked_by_name, '?') as un,
                 coalesce(i.marked_at, i.checked_at) as at
            from public.inv_audit_items i join public.inv_audits au on au.id = i.audit_id
           where au.branch = v_branch and i.status is not null
        ) t
       where t.d in (
         select distinct (coalesce(i2.marked_at, i2.checked_at) at time zone 'Asia/Seoul')::date
           from public.inv_audit_items i2 join public.inv_audits a2 on a2.id = i2.audit_id
          where a2.branch = v_branch and a2.compacted_at is null and i2.status is not null
            and a2.period_end < (now() at time zone 'Asia/Seoul')::date - v_days)
    ) g group by g.d, g.uk
  on conflict (stat_date, branch, user_key) do nothing;

  for a in select id, kind from public.inv_audits
            where branch = v_branch and compacted_at is null
              and period_end < (now() at time zone 'Asia/Seoul')::date - v_days
            order by period_end loop
    -- 확인 건수
    insert into public.inv_stat_audit_sum as s (stat_date, branch, user_key, user_name, kind, via, result, n)
    select (coalesce(i.marked_at, i.checked_at) at time zone 'Asia/Seoul')::date, v_branch,
           coalesce(i.checked_by::text, 'name:' || coalesce(i.checked_by_name, '?')), max(coalesce(i.checked_by_name, '?')),
           a.kind, coalesce(i.loc_via, 'unknown'), i.status, count(*)::integer
      from public.inv_audit_items i
     where i.audit_id = a.id and i.status is not null
     group by 1, 3, coalesce(i.loc_via, 'unknown'), i.status
    on conflict (stat_date, branch, user_key, kind, via, result) do update set n = s.n + excluded.n, user_name = excluded.user_name;
    -- 부품별 마지막 확인
    insert into public.inv_last_check as l (branch, item_cd, checked_at, status, counted, qty, rr_qty, checked_by_name, kind)
    select v_branch, i.item_cd, coalesce(i.checked_at, i.marked_at), i.status, i.counted, i.qty, i.rr_qty, i.checked_by_name, a.kind
      from public.inv_audit_items i
     where i.audit_id = a.id and i.status is not null and coalesce(i.checked_at, i.marked_at) is not null
    on conflict (branch, item_cd) do update
       set checked_at = excluded.checked_at, status = excluded.status, counted = excluded.counted, qty = excluded.qty,
           rr_qty = excluded.rr_qty, checked_by_name = excluded.checked_by_name, kind = excluded.kind
     where excluded.checked_at > l.checked_at;
    -- 조사 요약
    update public.inv_audits u
       set compacted_at = now(),
           sum_total = x.total, sum_ok = x.ok, sum_diff = x.diff, sum_unchecked = x.unchecked, sum_exempt = x.exempt, sum_workers = x.workers,
           sum_removed = jsonb_array_length(u.qty_removed), qty_removed = '[]'::jsonb
      from (select count(*)::integer as total,
                   count(*) filter (where status = 'ok')::integer as ok,
                   count(*) filter (where status = 'diff')::integer as diff,
                   count(*) filter (where status is null)::integer as unchecked,
                   count(*) filter (where status is not null and loc_via = 'exempt')::integer as exempt,
                   count(distinct checked_by) filter (where status is not null)::integer as workers
              from public.inv_audit_items where audit_id = a.id) x
     where u.id = a.id;
    delete from public.inv_audit_items where audit_id = a.id;
    get diagnostics v_n = row_count;
    v_items := v_items + v_n; v_audits := v_audits + 1;
  end loop;

  delete from public.inv_requests where branch = v_branch and kind = 'stock' and requested_at < now() - interval '3 days';
  get diagnostics v_req = row_count;
  update public.inv_requests set result = null where branch = v_branch and kind = 'rdc' and result is not null and requested_at < now() - interval '7 days';
  get diagnostics v_rdc = row_count;
  delete from public.inv_scan_diag where branch = v_branch and created_at < now() - interval '14 days';
  get diagnostics v_diag = row_count;
  delete from public.inv_aging_picks where branch = v_branch and picked_on < (now() at time zone 'Asia/Seoul')::date - 400;

  return jsonb_build_object('audits', v_audits, 'items', v_items, 'requests', v_req, 'rdc', v_rdc, 'diag', v_diag);
end;
$$;
revoke execute on function public.inv_compact(integer) from public, anon;
grant execute on function public.inv_compact(integer) to authenticated;


-- ===== 정리한 자료도 함께 읽도록 기존 함수 고침 =====

create or replace function public.inv_build_aging(p_day date, p_candidates jsonb, p_count integer default 10, p_days integer default 180)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_branch text := public.inv_daemon_branch();
  v_round  integer;
  v_items  jsonb := '[]'::jsonb;
  v_carry  text[] := '{}';
  v_taken  text[] := '{}';
  v_n      integer;
begin
  if v_branch is null then
    raise exception '데몬 계정이 아닙니다';
  end if;
  if exists (select 1 from public.inv_audit_source where branch = v_branch and kind = 'aging' and period_start = p_day) then
    return -1;
  end if;

  select coalesce(max(round), 1) into v_round from public.inv_aging_picks where branch = v_branch;

  drop table if exists _cand;
  create temp table _cand on commit drop as
  select distinct on (x->>'item_cd') x->>'item_cd' as item_cd, x as item, null::date as carry_from
    from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb)) x
   where coalesce(x->>'item_cd', '') <> ''
     and not exists (   -- 최근 p_days 일 안에 재고조사에서 확인한 부품
       select 1 from public.inv_audit_items i join public.inv_audits a on a.id = i.audit_id
        where a.branch = v_branch and i.item_cd = x->>'item_cd'
          and i.status is not null and i.checked_at >= now() - make_interval(days => p_days))
     and not exists (   -- 상세를 정리한 옛 조사에서 확인한 부품
       select 1 from public.inv_last_check l
        where l.branch = v_branch and l.item_cd = x->>'item_cd' and l.checked_at >= now() - make_interval(days => p_days));

  -- 이월: 전에 뽑혔는데 그 뒤로 확인 안 된 부품. 처음 뽑힌(아직 확인 안 된) 날짜
  update _cand c set carry_from = u.first_day
    from (
      select p.item_cd, min(p.picked_on) as first_day
        from public.inv_aging_picks p
       where p.branch = v_branch and p.picked_on < p_day
         and not exists (
           select 1 from public.inv_audit_items i join public.inv_audits a on a.id = i.audit_id
            where a.branch = v_branch and i.item_cd = p.item_cd and i.status is not null
              and (i.checked_at at time zone 'Asia/Seoul')::date >= p.picked_on)
       group by p.item_cd
    ) u
   where u.item_cd = c.item_cd;

  -- 1) 이월 부품 먼저 (오래된 것부터, 10개 안에서)
  select coalesce(array_agg(item_cd order by carry_from, item_cd), '{}') into v_carry from (
    select item_cd, carry_from from _cand where carry_from is not null order by carry_from, item_cd limit p_count) t;

  -- 2) 남은 자리는 이번 바퀴에서 아직 안 뽑힌 것 무작위
  select coalesce(array_agg(item_cd), '{}') into v_taken from (
    select c.item_cd from _cand c
     where not (c.item_cd = any (v_carry))
       and not exists (select 1 from public.inv_aging_picks p where p.branch = v_branch and p.round = v_round and p.item_cd = c.item_cd)
     order by random() limit greatest(p_count - cardinality(v_carry), 0)) t;
  insert into public.inv_aging_picks (branch, round, item_cd, picked_on)
  select v_branch, v_round, unnest(v_taken), p_day;

  -- 3) 그래도 모자라면 한 바퀴 끝 → 새 바퀴에서 채움
  v_n := cardinality(v_carry) + cardinality(v_taken);
  if v_n < p_count then
    v_round := v_round + 1;
    with more as (
      select c.item_cd from _cand c
       where not (c.item_cd = any (v_carry)) and not (c.item_cd = any (v_taken))
       order by random() limit p_count - v_n)
    insert into public.inv_aging_picks (branch, round, item_cd, picked_on)
    select v_branch, v_round, item_cd, p_day from more;
    select v_taken || coalesce(array_agg(item_cd), '{}') into v_taken
      from public.inv_aging_picks where branch = v_branch and round = v_round and picked_on = p_day;
  end if;

  select coalesce(jsonb_agg(
           case when c.carry_from is not null and c.item_cd = any (v_carry)
                then c.item || jsonb_build_object('carry_from', c.carry_from) else c.item end
           order by c.item->>'lct_cd', c.item_cd), '[]'::jsonb) into v_items
    from _cand c where c.item_cd = any (v_carry) or c.item_cd = any (v_taken);

  insert into public.inv_audit_source (branch, kind, period_start, period_end, items, updated_at)
  values (v_branch, 'aging', p_day, p_day, v_items, now())
  on conflict (branch, kind) do update
     set period_start = excluded.period_start, period_end = excluded.period_end, items = excluded.items, updated_at = excluded.updated_at;
  return jsonb_array_length(v_items);
end;
$$;

create or replace function public.inv_stat_daily(p_from date, p_to date)
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
  select s.stat_date, s.branch, s.user_key, s.user_name, 'audit_check'::text, s.kind, s.via, s.result, s.n
    from public.inv_stat_audit_sum s
   where s.stat_date between p_from and p_to
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

create or replace function public.inv_stat_active(p_from date, p_to date)
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
  , live as (
    select g.d, g.b, g.uk, max(g.un) as un, count(*)::integer as checks,
           coalesce(sum(case when g.gap is not null and g.gap <= 300 then g.gap else 0 end), 0)::integer as sec, min(g.at) as f, max(g.at) as l
      from g
     where not exists (select 1 from public.inv_stat_active_sum z where z.stat_date = g.d and z.branch = g.b and z.user_key = g.uk)
     group by g.d, g.b, g.uk
    union all
    select s.stat_date, s.branch, s.user_key, s.user_name, s.checks, s.active_sec, s.first_at, s.last_at
      from public.inv_stat_active_sum s where s.stat_date between p_from and p_to
  )
  select live.d, live.b, live.uk, max(live.un), sum(live.checks)::integer, sum(live.sec)::integer, min(live.f), max(live.l)
    from live group by live.d, live.b, live.uk;
end;
$$;

create or replace function public.inv_stat_audits(p_from date, p_to date)
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
   where a.period_start between p_from and p_to and a.compacted_at is null
   group by a.id
  union all
  select a.id, a.branch, a.kind, a.period_start, a.period_end, a.started_at, a.started_by_name, a.finished_at, a.finished_by_name,
         a.sum_total, a.sum_ok, a.sum_diff, a.sum_unchecked, a.sum_exempt, a.sum_removed, a.sum_workers
    from public.inv_audits a
   where a.period_start between p_from and p_to and a.compacted_at is not null;
end;
$$;

-- 예전 정리 함수(020·021)는 inv_compact 로 합침
drop function if exists public.inv_cleanup_requests(integer);
