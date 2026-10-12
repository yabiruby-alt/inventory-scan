-- 스캔 탭에서 "재고 일치"를 누른 뒤 같은 날 "수량 다름"으로 체크하면 (2026-10-12 결정)
--   - 그날의 스캔 일치 건수(spot_check)에서 1건 뺌
--   - 부품별 마지막 확인(inv_last_check)을 수량 다름으로 바꿈 → 체크를 지워도 '일치 확인됨'으로 돌아가지 않고, 다시 일치를 눌러야 함
--   건수를 정확히 빼려면 누가·어떤 방식으로 일치를 눌렀는지 알아야 하므로 inv_last_check 에 남김

alter table public.inv_last_check
  add column checked_by uuid,   -- 스캔 탭 재고 일치를 누른 계정 (재고조사에서 옮겨 온 줄은 null)
  add column via        text;   -- scanner | camera | part

create or replace function public.inv_spot_ok(p_item text, p_via text) returns jsonb
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

  -- 같은 사람이 같은 날 같은 부품을 다시 누른 것은 건수에 더하지 않음 (그 사이 수량 다름으로 바뀌었으면 다시 셈)
  select kind, status, checked_by_name, checked_at into v_prev from public.inv_last_check where branch = v_branch and item_cd = p_item;
  if found then
    v_again := v_prev.kind = 'scan' and v_prev.status = 'ok' and v_prev.checked_by_name is not distinct from v_name
               and (v_prev.checked_at at time zone 'Asia/Seoul')::date = v_today;
  end if;
  if not v_again then
    insert into public.inv_stat_audit_sum as s (stat_date, branch, user_key, user_name, kind, via, result, n)
    values (v_today, v_branch, auth.uid()::text, coalesce(v_name, '?'), 'scan', p_via, 'ok', 1)
    on conflict (stat_date, branch, user_key, kind, via, result) do update set n = s.n + 1, user_name = excluded.user_name;
  end if;

  insert into public.inv_last_check as l (branch, item_cd, checked_at, status, counted, qty, rr_qty, checked_by_name, kind, checked_by, via)
  values (v_branch, p_item, now(), 'ok', coalesce(v_qty, 0) + coalesce(v_rr, 0), v_qty, v_rr, v_name, 'scan', auth.uid(), p_via)
  on conflict (branch, item_cd) do update
     set checked_at = excluded.checked_at, status = excluded.status, counted = excluded.counted, qty = excluded.qty,
         rr_qty = excluded.rr_qty, checked_by_name = excluded.checked_by_name, kind = excluded.kind,
         checked_by = excluded.checked_by, via = excluded.via;

  update public.inv_checks set cleared_at = now(), cleared_by_name = v_name
   where branch = v_branch and item_cd = p_item and cleared_at is null;
  get diagnostics v_cleared = row_count;

  return jsonb_build_object('checked_at', now(), 'qty', v_qty, 'rr_qty', v_rr, 'cleared', v_cleared);
end;
$$;

-- 스캔 탭에서 건 수량 다름 체크(재고조사에서 생긴 것은 audit_id 가 있어 제외)
create function public.inv_check_spot_diff() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_prev  record;
begin
  if new.audit_id is not null then
    return new;
  end if;
  select kind, status, checked_at, checked_by, via into v_prev
    from public.inv_last_check where branch = new.branch and item_cd = new.item_cd;
  -- 오늘 누른 스캔 일치가 있었으면 그 건수를 뺌
  if found and v_prev.kind = 'scan' and v_prev.status = 'ok' and v_prev.checked_by is not null and v_prev.via is not null
     and (v_prev.checked_at at time zone 'Asia/Seoul')::date = v_today then
    update public.inv_stat_audit_sum
       set n = greatest(n - 1, 0)
     where stat_date = v_today and branch = new.branch and user_key = v_prev.checked_by::text
       and kind = 'scan' and via = v_prev.via and result = 'ok';
  end if;
  insert into public.inv_last_check as l (branch, item_cd, checked_at, status, counted, qty, rr_qty, checked_by_name, kind, checked_by, via)
  values (new.branch, new.item_cd, now(), 'diff', new.counted_qty, new.dms_qty, new.rr_qty, new.checked_by_name, 'scan', null, null)
  on conflict (branch, item_cd) do update
     set checked_at = excluded.checked_at, status = excluded.status, counted = excluded.counted, qty = excluded.qty,
         rr_qty = excluded.rr_qty, checked_by_name = excluded.checked_by_name, kind = excluded.kind,
         checked_by = null, via = null;
  return new;
end;
$$;
create trigger inv_checks_spot_diff after insert on public.inv_checks
  for each row execute function public.inv_check_spot_diff();
