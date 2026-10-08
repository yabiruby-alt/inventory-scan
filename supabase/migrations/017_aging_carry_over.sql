-- 일일장기 재고조사 이월: 뽑혔는데 확인(일치/수량 다름) 안 된 부품은 다음 날 목록에 먼저 넣음 (하루 10개 안에서)
--   - 조사를 시작 안 한 날, 확인 안 하고 종료한 날 모두 해당
--   - 그 사이 재고 0·장기 조건 벗어남·다른 재고조사에서 확인됨 → 후보에서 빠지므로 자연히 이월 안 됨
--   - 이월 부품은 처음 뽑힌 날(carry_from)을 남겨 목록·보고서에 "이월 10/8" 로 표시
--   - 확인 시각 비교는 한국 날짜 기준

alter table public.inv_audit_items add column carry_from date;

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
          and i.status is not null and i.checked_at >= now() - make_interval(days => p_days));

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

-- 조사 시작: 이월 날짜도 항목에 복사 (나머지는 012 와 같음)
create or replace function public.inv_start_audit(p_kind text) returns uuid
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
  on conflict (branch, kind, period_start, period_end) do nothing
  returning id into v_id;
  if v_id is null then   -- 이미 누가 시작함
    select id into v_id from public.inv_audits
     where branch = v_branch and kind = p_kind and period_start = v_src.period_start and period_end = v_src.period_end;
    return v_id;
  end if;
  insert into public.inv_audit_items (audit_id, item_cd, item_nm, lct_cd, qty, rr_qty, carry_from)
  select v_id, x->>'item_cd', x->>'item_nm', x->>'lct_cd', (x->>'qty')::numeric, coalesce(r.crt_qty, 0), (x->>'carry_from')::date
  from jsonb_array_elements(v_src.items) x
  left join public.inv_rr_parts r on r.branch = v_branch and r.item_cd = x->>'item_cd';
  return v_id;
end;
$$;
