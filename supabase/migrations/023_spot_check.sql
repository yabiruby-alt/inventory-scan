-- 스캔 탭 "재고 일치" (재고조사가 아니어도 바코드를 찍고 수량이 맞으면 일치로 기록, 2026-10-12 결정)
--   - 기록은 부품별 마지막 확인(inv_last_check)에 kind = 'scan' 으로 남김 (지점·부품당 1줄 → 용량이 늘지 않음)
--     → 부품 화면 '마지막 재고 확인'에 나오고, 일일장기 재고조사의 180일 제외에도 그대로 적용됨(inv_build_aging 이 이 표를 봄)
--   - 건수는 inv_stat_audit_sum 에 kind = 'scan' 으로 하루·사람 단위로 더함 → inv_stat_daily 에서 metric = 'spot_check'
--   - 그 부품에 열려 있던 수량 다름 체크는 지움
--   - 바코드를 찍은 경우만: p_via = scanner|camera(위치를 찍고 들어옴) | part(부품 바코드를 찍음)

create function public.inv_spot_ok(p_item text, p_via text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_branch  text := public.inv_user_branch();
  v_name    text := public.inv_user_name();
  v_today   date := (now() at time zone 'Asia/Seoul')::date;
  v_qty     numeric;
  v_rr      numeric;
  v_prev    record;
  v_again   boolean := false;
  v_cleared integer;
begin
  if v_branch is null then
    raise exception '로그인한 직원 계정이 아닙니다';
  end if;
  if p_via is null or p_via not in ('scanner', 'camera', 'part') then
    raise exception '바코드를 스캔한 뒤에 누를 수 있습니다';
  end if;
  select crt_qty into v_qty from public.inv_parts where branch = v_branch and item_cd = p_item;
  if not found then
    raise exception '재고 목록에 없는 부품입니다';
  end if;
  select crt_qty into v_rr from public.inv_rr_parts where branch = v_branch and item_cd = p_item;

  -- 같은 사람이 같은 날 같은 부품을 다시 누른 것은 건수에 더하지 않음
  select kind, checked_by_name, checked_at into v_prev from public.inv_last_check where branch = v_branch and item_cd = p_item;
  if found then
    v_again := v_prev.kind = 'scan' and v_prev.checked_by_name is not distinct from v_name
               and (v_prev.checked_at at time zone 'Asia/Seoul')::date = v_today;
  end if;
  if not v_again then
    insert into public.inv_stat_audit_sum as s (stat_date, branch, user_key, user_name, kind, via, result, n)
    values (v_today, v_branch, auth.uid()::text, coalesce(v_name, '?'), 'scan', p_via, 'ok', 1)
    on conflict (stat_date, branch, user_key, kind, via, result) do update set n = s.n + 1, user_name = excluded.user_name;
  end if;

  insert into public.inv_last_check as l (branch, item_cd, checked_at, status, counted, qty, rr_qty, checked_by_name, kind)
  values (v_branch, p_item, now(), 'ok', coalesce(v_qty, 0) + coalesce(v_rr, 0), v_qty, v_rr, v_name, 'scan')
  on conflict (branch, item_cd) do update
     set checked_at = excluded.checked_at, status = excluded.status, counted = excluded.counted, qty = excluded.qty,
         rr_qty = excluded.rr_qty, checked_by_name = excluded.checked_by_name, kind = excluded.kind;

  update public.inv_checks set cleared_at = now(), cleared_by_name = v_name
   where branch = v_branch and item_cd = p_item and cleared_at is null;
  get diagnostics v_cleared = row_count;

  return jsonb_build_object('checked_at', now(), 'qty', v_qty, 'rr_qty', v_rr, 'cleared', v_cleared);
end;
$$;
revoke execute on function public.inv_spot_ok(text, text) from public, anon;
grant execute on function public.inv_spot_ok(text, text) to authenticated;

-- 일별 건수: 스캔 탭 재고 일치를 metric = 'spot_check' 로 따로 냄 (kind = 'scan', via = scanner|camera|part, result = 'ok')
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
  select s.stat_date, s.branch, s.user_key, s.user_name,
         case when s.kind = 'scan' then 'spot_check' else 'audit_check' end, s.kind, s.via, s.result, s.n
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
