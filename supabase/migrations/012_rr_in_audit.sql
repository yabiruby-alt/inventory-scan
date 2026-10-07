-- 재고조사·수량 다름 체크에 RR 재고 포함: 실사 수량은 BMW + RR 합계와 비교
--   같은 자리에 BMW·RR 부품이 함께 있어 센 수량은 합계이므로

-- 조사 시작 때의 RR 수량 (BMW 수량 qty 와 같이 고정). 예전 조사는 null → 앱이 최신 RR 현재고를 씀
alter table public.inv_audit_items add column rr_qty numeric;
-- 체크할 때의 RR 수량. 차이 = 실사 - (DMS + RR)
alter table public.inv_checks add column rr_qty numeric;
grant update (rr_qty) on public.inv_checks to authenticated;

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
  insert into public.inv_audit_items (audit_id, item_cd, item_nm, lct_cd, qty, rr_qty)
  select v_id, x->>'item_cd', x->>'item_nm', x->>'lct_cd', (x->>'qty')::numeric, coalesce(r.crt_qty, 0)
  from jsonb_array_elements(v_src.items) x
  left join public.inv_rr_parts r on r.branch = v_branch and r.item_cd = x->>'item_cd';
  return v_id;
end;
$$;

-- 체크 기록: RR 수량이 바뀌어도 고친 사람·시각을 서버가 채움
create or replace function public.inv_stamp_check_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.counted_qty is distinct from old.counted_qty or new.memo is distinct from old.memo
     or new.dms_qty is distinct from old.dms_qty or new.rr_qty is distinct from old.rr_qty then
    new.checked_by := auth.uid();
    new.checked_by_name := public.inv_user_name();
    new.checked_at := now();
  else
    new.checked_by := old.checked_by;
    new.checked_by_name := old.checked_by_name;
    new.checked_at := old.checked_at;
  end if;
  if new.cleared_at is distinct from old.cleared_at then
    if new.cleared_at is null then
      new.cleared_by_name := null;
    else
      new.cleared_at := now();
      new.cleared_by_name := public.inv_user_name();
    end if;
  else
    new.cleared_by_name := old.cleared_by_name;
  end if;
  return new;
end;
$$;
