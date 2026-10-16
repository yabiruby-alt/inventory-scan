-- 오래 안 본 부품을 일일장기 재고조사에 먼저 넣기 (2026-10-16 결정)
--   1) inv_build_aging: 남는 자리를 "무작위"가 아니라 "바코드로 스캔한 지 가장 오래된 부품 우선"으로 채움
--      - 스캔한 날은 inv_stat_seen(028)의 날짜 비트에서 마지막 날을 읽음. 한 번도 스캔 기록이 없으면 가장 오래된 것으로 봄(0)
--      - 같은 순위끼리는 무작위. 이월 부품 먼저, 한 바퀴 돌 때까지 겹치지 않음, 최근 180일 재고조사 확인 부품 제외는 그대로
--      - 스캔 기록은 2026-10-12부터라 처음 한동안은 거의 모든 부품이 "기록 없음"(= 지금처럼 무작위). 기록이 쌓일수록 효과가 커짐
--   2) inv_stat_unseen: 통계 대시보드의 "오래 안 본 부품" (재고가 있는 부품 중 최근 30일·90일 스캔하지 않은 부품 수, 지점별)

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
  select distinct on (x->>'item_cd') x->>'item_cd' as item_cd, x as item, null::date as carry_from,
         -- 마지막으로 바코드 스캔한 날 번호(2026-10-12 = 1). 기록이 없으면 0 → 가장 먼저 뽑힘
         coalesce((select length(rtrim(s.days::text, '0')) from public.inv_stat_seen s
                    where s.branch = v_branch and s.item_h = hashtextextended(x->>'item_cd', 0)), 0) as seen_day
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

  -- 2) 남은 자리는 이번 바퀴에서 아직 안 뽑힌 것 중 스캔한 지 가장 오래된 부품부터 (같은 순위는 무작위)
  select coalesce(array_agg(item_cd order by seen_day, rnd), '{}') into v_taken from (
    select c.item_cd, c.seen_day, random() as rnd from _cand c
     where not (c.item_cd = any (v_carry))
       and not exists (select 1 from public.inv_aging_picks p where p.branch = v_branch and p.round = v_round and p.item_cd = c.item_cd)
     order by c.seen_day, rnd limit greatest(p_count - cardinality(v_carry), 0)) t;
  insert into public.inv_aging_picks (branch, round, item_cd, picked_on)
  select v_branch, v_round, unnest(v_taken), p_day;

  -- 3) 그래도 모자라면 한 바퀴 끝 → 새 바퀴에서 채움 (여기도 스캔한 지 오래된 부품부터)
  v_n := cardinality(v_carry) + cardinality(v_taken);
  if v_n < p_count then
    v_round := v_round + 1;
    with more as (
      select c.item_cd from _cand c
       where not (c.item_cd = any (v_carry)) and not (c.item_cd = any (v_taken))
       order by c.seen_day, random() limit p_count - v_n)
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

-- 통계 대시보드: 재고가 있는 부품 중 최근 N일 스캔하지 않은 부품 수 (지점별)
--   tracked_days = 스캔 기록을 쌓기 시작한 지 며칠째 (2026-10-12 = 1일째). N일보다 작으면 그 값은 아직 믿을 수 없음
create function public.inv_stat_unseen()
returns table (branch text, parts integer, unseen_30 integer, unseen_90 integer, tracked_days integer)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  c_base constant date := date '2026-10-12';
  v_idx  integer := (now() at time zone 'Asia/Seoul')::date - c_base;   -- 오늘의 비트 번호(0부터)
begin
  if public.my_role() is null then
    raise exception '사용 중인 계정이 아닙니다';
  end if;
  return query
  select p.branch, count(*)::integer,
         count(*) filter (where s.days is null or bit_count(substring(s.days from greatest(v_idx - 29 + 1, 1) for greatest(v_idx - greatest(v_idx - 29 + 1, 1) + 2, 1))) = 0)::integer,
         count(*) filter (where s.days is null or bit_count(substring(s.days from greatest(v_idx - 89 + 1, 1) for greatest(v_idx - greatest(v_idx - 89 + 1, 1) + 2, 1))) = 0)::integer,
         (v_idx + 1)::integer
    from public.inv_parts p
    left join public.inv_stat_seen s on s.branch = p.branch and s.item_h = hashtextextended(p.item_cd, 0)
   where p.crt_qty > 0
   group by p.branch;
end;
$$;
revoke execute on function public.inv_stat_unseen() from public, anon;
grant execute on function public.inv_stat_unseen() to authenticated;
