-- 재고조사 DMS 갱신 때 위치도 최근 DMS 위치로 (위치 없음이던 부품, 조사 시작 뒤 위치를 옮긴 부품)
--   남은(확인 안 한) 부품만. BMW 현재고에 있으면 그 위치(DMS 에서 비어 있으면 위치 없음),
--   BMW 현재고에 없으면(재고 0) RR 현재고 위치, 둘 다 없으면 원래 위치 그대로

create or replace function public.inv_refresh_audit(p_id uuid) returns integer
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
           case when v_rr then coalesce(r.crt_qty, 0) else i.rr_qty end as rr_qty,
           case when p.item_cd is not null then nullif(btrim(coalesce(p.lct_cd, '')), '')
                when r.item_cd is not null then coalesce(nullif(btrim(coalesce(r.lct_cd, '')), ''), i.lct_cd)
                else i.lct_cd end as lct_cd
      from public.inv_audit_items i
      left join public.inv_parts p    on p.branch = v_branch and p.item_cd = i.item_cd
      left join public.inv_rr_parts r on r.branch = v_branch and r.item_cd = i.item_cd
     where i.audit_id = p_id and i.status is null
  )
  update public.inv_audit_items i
     set qty = cur.qty, rr_qty = cur.rr_qty, lct_cd = cur.lct_cd
    from cur
   where i.audit_id = p_id and i.item_cd = cur.item_cd
     and (i.qty is distinct from cur.qty or i.rr_qty is distinct from cur.rr_qty
          or nullif(i.lct_cd, '') is distinct from cur.lct_cd);
  get diagnostics v_n = row_count;

  update public.inv_audits
     set qty_refreshed_at = now(), qty_refreshed_by_name = public.inv_user_name(),
         qty_basis_at = (select parts_at from public.inv_status where branch = v_branch)
   where id = p_id;
  return v_n;
end;
$$;
