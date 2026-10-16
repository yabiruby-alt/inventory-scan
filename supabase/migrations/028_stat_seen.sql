-- 스캔한 부품 라인수 (통계 대시보드용, 2026-10-16 결정)
--   "라인" = 서로 다른 부품 하나. 기간 안에 바코드로 한 번이라도 스캔한 부품은 몇 번을 찍어도 1라인.
--   기간을 바꿔 가며 세려면 어떤 부품을 언제 봤는지가 서버에 있어야 하므로,
--   날짜마다 줄을 쌓지 않고 "지점·부품당 1줄 + 본 날짜 비트"로 둔다 → 줄 수는 (지점 수 × 부품 종류)로 고정되어 용량이 거의 늘지 않음
--   - 부품은 부품번호 해시(8바이트)로만 저장 (번호 자체는 이 표에 없음). 재고 목록(inv_parts)에 있는 부품만 받음
--   - 날짜 비트: 맨 왼쪽 비트 = 2026-10-12(통계 시작일), 하루에 1비트. 켜져 있으면 그날 스캔함
--   - 사용자별 값은 두지 않음 (사용자별은 기존 재고조사 확인·스캔 탭 재고 일치 건수로 봄)
--   - 앱이 하루에 부품당 한 번만 보냄 (같은 걸 다시 보내도 변화 없음)

create table public.inv_stat_seen (
  branch text   not null,
  item_h bigint not null,            -- hashtextextended(부품번호, 0)
  days   varbit not null,            -- 본 날짜 비트
  primary key (branch, item_h)
);
alter table public.inv_stat_seen enable row level security;
-- 표는 직접 읽지 않고 아래 함수로만

-- 앱이 부름. p_rows: [{d:'2026-10-16', items:['A1','B2', ...]}, ...]  → 새로 켠 비트 수를 돌려줌
create function public.inv_stat_seen_push(p_rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare
  c_base   constant date := date '2026-10-12';
  v_branch text := public.inv_user_branch();
  v_today  date := (now() at time zone 'Asia/Seoul')::date;
  r        jsonb;
  v_item   text;
  v_d      date;
  v_idx    integer;
  v_h      bigint;
  v_old    varbit;
  v_new    varbit;
  v_n      integer := 0;
begin
  if v_branch is null then
    raise exception '로그인한 직원 계정이 아닙니다';
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_d := (r->>'d')::date;
    if v_d < v_today - 14 or v_d > v_today + 1 or v_d < c_base then continue; end if;
    v_idx := v_d - c_base;
    for v_item in select distinct x from jsonb_array_elements_text(coalesce(r->'items', '[]'::jsonb)) x limit 2000 loop
      if not exists (select 1 from public.inv_parts p where p.branch = v_branch and p.item_cd = v_item) then continue; end if;
      v_h := hashtextextended(v_item, 0);
      select days into v_old from public.inv_stat_seen where branch = v_branch and item_h = v_h;
      if not found then
        insert into public.inv_stat_seen (branch, item_h, days) values (v_branch, v_h, (repeat('0', v_idx) || '1')::varbit)
        on conflict (branch, item_h) do nothing;
        v_n := v_n + 1;
      elsif length(v_old) > v_idx then
        if substring(v_old from v_idx + 1 for 1) = B'0' then
          update public.inv_stat_seen set days = set_bit(days, v_idx, 1) where branch = v_branch and item_h = v_h;
          v_n := v_n + 1;
        end if;
      else
        v_new := v_old || (repeat('0', v_idx - length(v_old)) || '1')::varbit;
        update public.inv_stat_seen set days = v_new where branch = v_branch and item_h = v_h;
        v_n := v_n + 1;
      end if;
    end loop;
  end loop;
  return v_n;
end;
$$;
revoke execute on function public.inv_stat_seen_push(jsonb) from public, anon;
grant execute on function public.inv_stat_seen_push(jsonb) to authenticated;

-- 기간 안에 한 번이라도 스캔한 서로 다른 부품 수 (지점별). 같은 부품은 며칠을 찍어도 1라인
create function public.inv_stat_lines(p_from date, p_to date)
returns table (branch text, lines integer)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  c_base constant date := date '2026-10-12';
  v_a integer := greatest(p_from - c_base, 0);
  v_n integer := p_to - greatest(p_from, c_base) + 1;
begin
  if public.my_role() is null then
    raise exception '사용 중인 계정이 아닙니다';
  end if;
  if v_n < 1 then
    return;
  end if;
  return query
  select s.branch, count(*)::integer
    from public.inv_stat_seen s
   where bit_count(substring(s.days from v_a + 1 for v_n)) > 0
   group by s.branch;
end;
$$;

-- 날짜별 서로 다른 부품 수 (지점별) — 그날 스캔한 부품 라인수
create function public.inv_stat_lines_daily(p_from date, p_to date)
returns table (stat_date date, branch text, lines integer)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  c_base constant date := date '2026-10-12';
begin
  if public.my_role() is null then
    raise exception '사용 중인 계정이 아닙니다';
  end if;
  return query
  select d::date, s.branch, count(*)::integer
    from generate_series(greatest(p_from, c_base), p_to, interval '1 day') d
    join public.inv_stat_seen s on length(s.days) > (d::date - c_base)
     and substring(s.days from (d::date - c_base) + 1 for 1) = B'1'
   group by d, s.branch;
end;
$$;

revoke execute on function public.inv_stat_lines(date, date), public.inv_stat_lines_daily(date, date) from public, anon;
grant execute on function public.inv_stat_lines(date, date), public.inv_stat_lines_daily(date, date) to authenticated;
