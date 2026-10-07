-- 같은 기간 재고조사가 두 개 생기지 않게
--   두 사람이 거의 동시에 "조사 시작"을 누르거나, 화면이 갱신되기 전에 누르면 조사가 둘로 나뉘던 문제.
--   이미 시작된 조사가 있으면 새로 만들지 않고 그 조사를 돌려줌.

create unique index inv_audits_period_uidx on public.inv_audits (branch, kind, period_start, period_end);

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
  if v_id is null then   -- 이미 누가 시작함 (동시에 눌렀으면 먼저 시작한 쪽이 끝날 때까지 기다렸다가 그 조사를 씀)
    select id into v_id from public.inv_audits
     where branch = v_branch and kind = p_kind and period_start = v_src.period_start and period_end = v_src.period_end;
    return v_id;
  end if;
  insert into public.inv_audit_items (audit_id, item_cd, item_nm, lct_cd, qty)
  select v_id, x->>'item_cd', x->>'item_nm', x->>'lct_cd', (x->>'qty')::numeric
  from jsonb_array_elements(v_src.items) x;
  return v_id;
end;
$$;
