-- 일일장기 재고조사 (kind 'aging'): 최종입고·최종출고가 180일 넘은(출고 이력 없음 포함) 부품창고 부품 중 하루 10개를 무작위로
--   - 그날 데몬이 처음 돌 때 정해서 하루 동안 고정 (모든 직원이 같은 목록)
--   - 한 바퀴(대상 전체)를 다 돌 때까지 이미 뽑힌 부품은 다시 안 뽑음 (inv_aging_picks.round)
--   - 최근 180일 안에 재고조사(일일·주간·일일장기)에서 일치/수량 다름으로 확인한 부품은 뺌
--   - 대상 후보(날짜 조건)는 데몬이 DMS 현재고리스트(lastPurcDt·lastSaleDt)로 골라 넘김. BMW 부품창고만

alter table public.inv_audit_source drop constraint inv_audit_source_kind_check;
alter table public.inv_audit_source add constraint inv_audit_source_kind_check check (kind in ('daily', 'weekly', 'aging'));
alter table public.inv_audits drop constraint inv_audits_kind_check;
alter table public.inv_audits add constraint inv_audits_kind_check check (kind in ('daily', 'weekly', 'aging'));

-- 뽑힌 기록 (한 바퀴 안에서 겹치지 않게)
create table public.inv_aging_picks (
  branch    text not null,
  round     integer not null,
  item_cd   text not null,
  picked_on date not null,
  primary key (branch, round, item_cd)
);
alter table public.inv_aging_picks enable row level security;
create policy "직원 조회" on public.inv_aging_picks for select to authenticated using (branch = public.inv_user_branch());
-- 쓰기는 아래 함수로만

-- 데몬이 매 주기 부름. 그날 목록이 이미 있으면 그대로(-1), 없으면 10개를 뽑아 inv_audit_source 에 올리고 건수를 돌려줌
--   p_candidates: [{item_cd, item_nm, lct_cd, qty, alois_cd, last_purc_dt, last_sale_dt}, ...]
create function public.inv_build_aging(p_day date, p_candidates jsonb, p_count integer default 10, p_days integer default 180)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_branch text := public.inv_daemon_branch();
  v_round  integer;
  v_items  jsonb := '[]'::jsonb;
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
  select distinct on (x->>'item_cd') x->>'item_cd' as item_cd, x as item
    from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb)) x
   where coalesce(x->>'item_cd', '') <> ''
     and not exists (   -- 최근 p_days 일 안에 재고조사에서 확인한 부품
       select 1 from public.inv_audit_items i join public.inv_audits a on a.id = i.audit_id
        where a.branch = v_branch and i.item_cd = x->>'item_cd'
          and i.status is not null and i.checked_at >= now() - make_interval(days => p_days));

  -- 이번 바퀴에서 아직 안 뽑힌 것부터
  select coalesce(array_agg(item_cd), '{}') into v_taken from (
    select c.item_cd from _cand c
     where not exists (select 1 from public.inv_aging_picks p where p.branch = v_branch and p.round = v_round and p.item_cd = c.item_cd)
     order by random() limit p_count) t;
  insert into public.inv_aging_picks (branch, round, item_cd, picked_on)
  select v_branch, v_round, unnest(v_taken), p_day;

  -- 모자라면 한 바퀴 끝 → 새 바퀴에서 채움 (방금 뽑은 것 제외)
  v_n := cardinality(v_taken);
  if v_n < p_count then
    v_round := v_round + 1;
    with more as (
      select c.item_cd from _cand c where not (c.item_cd = any (v_taken)) order by random() limit p_count - v_n)
    insert into public.inv_aging_picks (branch, round, item_cd, picked_on)
    select v_branch, v_round, item_cd, p_day from more;
    select v_taken || coalesce(array_agg(item_cd), '{}') into v_taken
      from public.inv_aging_picks where branch = v_branch and round = v_round and picked_on = p_day;
  end if;

  select coalesce(jsonb_agg(c.item order by c.item->>'lct_cd', c.item_cd), '[]'::jsonb) into v_items
    from _cand c where c.item_cd = any (v_taken);

  insert into public.inv_audit_source (branch, kind, period_start, period_end, items, updated_at)
  values (v_branch, 'aging', p_day, p_day, v_items, now())
  on conflict (branch, kind) do update
     set period_start = excluded.period_start, period_end = excluded.period_end, items = excluded.items, updated_at = excluded.updated_at;
  return jsonb_array_length(v_items);
end;
$$;
revoke execute on function public.inv_build_aging(date, jsonb, integer, integer) from public, anon;
grant execute on function public.inv_build_aging(date, jsonb, integer, integer) to authenticated;
