-- 재고조사 수량 DMS 갱신: 조사 시작 때 고정한 수량 중 아직 확인 안 한(남은) 부품만
--   데몬이 마지막 주기(10분마다)에 올린 현재고(inv_parts, inv_rr_parts)로 바꿈. 확인한 부품은 그대로

alter table public.inv_audits
  add column qty_refreshed_at      timestamptz,   -- 마지막으로 갱신한 시각
  add column qty_refreshed_by_name text,
  add column qty_basis_at          timestamptz;   -- 그때 쓴 DMS 현재고 기준 시각 (inv_status.parts_at)

create function public.inv_refresh_audit(p_id uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_branch text := public.inv_user_branch();
  v_rr     boolean;
  v_n      integer;
begin
  if not exists (select 1 from public.inv_audits where id = p_id and branch = v_branch) then
    raise exception '조사를 찾지 못했습니다';
  end if;
  if exists (select 1 from public.inv_audits where id = p_id and finished_at is not null) then
    raise exception '종료된 조사입니다';
  end if;
  -- 현재고가 비어 있으면(데몬 업로드 이상) 전부 0 으로 만들지 않게 멈춤
  if not exists (select 1 from public.inv_parts where branch = v_branch) then
    raise exception 'DMS 현재고가 아직 올라오지 않았습니다';
  end if;
  v_rr := exists (select 1 from public.inv_rr_parts where branch = v_branch);

  -- 현재고 목록에 없는 부품 = 재고 0 (데몬은 재고 있는 부품만 올림). RR 이 아직 없으면 RR 수량은 그대로
  with cur as (
    select i.item_cd,
           coalesce(p.crt_qty, 0) as qty,
           case when v_rr then coalesce(r.crt_qty, 0) else i.rr_qty end as rr_qty
      from public.inv_audit_items i
      left join public.inv_parts p    on p.branch = v_branch and p.item_cd = i.item_cd
      left join public.inv_rr_parts r on r.branch = v_branch and r.item_cd = i.item_cd
     where i.audit_id = p_id and i.status is null
  )
  update public.inv_audit_items i
     set qty = cur.qty, rr_qty = cur.rr_qty
    from cur
   where i.audit_id = p_id and i.item_cd = cur.item_cd and (i.qty is distinct from cur.qty or i.rr_qty is distinct from cur.rr_qty);
  get diagnostics v_n = row_count;

  update public.inv_audits
     set qty_refreshed_at = now(), qty_refreshed_by_name = public.inv_user_name(),
         qty_basis_at = (select parts_at from public.inv_status where branch = v_branch)
   where id = p_id;
  return v_n;
end;
$$;
revoke execute on function public.inv_refresh_audit(uuid) from public, anon;
grant execute on function public.inv_refresh_audit(uuid) to authenticated;
