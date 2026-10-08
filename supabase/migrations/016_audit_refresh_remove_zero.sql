-- 재고조사 DMS 갱신 때 수량 0 이 된 부품(BMW + RR 합계 0)은 목록에서 뺌 (남은 부품만, 확인한 부품은 그대로)
--   뺀 부품은 inv_audits.qty_removed 에 남김 → 보고서 "DMS 재고 0으로 제외" 와 스캔 안내에 씀
--   (DMS 는 0 인데 실물이 남아 있는 경우를 놓치지 않게)
--   돌려주는 값: {"changed": 수량·위치가 바뀐 건수, "removed": 뺀 건수}

alter table public.inv_audits add column qty_removed jsonb not null default '[]'::jsonb;

drop function public.inv_refresh_audit(uuid);
create function public.inv_refresh_audit(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_branch  text := public.inv_user_branch();
  v_rr      boolean;
  v_changed integer;
  v_removed jsonb;
begin
  if not exists (select 1 from public.inv_audits where id = p_id and branch = v_branch) then
    raise exception '조사를 찾지 못했습니다';
  end if;
  if exists (select 1 from public.inv_audits where id = p_id and finished_at is not null) then
    raise exception '종료된 조사입니다';
  end if;
  -- 현재고가 비어 있으면(데몬 업로드 이상) 전부 0 으로 보고 지우지 않게 멈춤
  if not exists (select 1 from public.inv_parts where branch = v_branch) then
    raise exception 'DMS 현재고가 아직 올라오지 않았습니다';
  end if;
  v_rr := exists (select 1 from public.inv_rr_parts where branch = v_branch);

  drop table if exists _cur;
  create temp table _cur on commit drop as
  select i.item_cd, i.item_nm, i.lct_cd as old_lct, i.qty as old_qty, i.rr_qty as old_rr,
         coalesce(p.crt_qty, 0) as qty,
         case when v_rr then coalesce(r.crt_qty, 0) else i.rr_qty end as rr_qty,
         case when p.item_cd is not null then nullif(btrim(coalesce(p.lct_cd, '')), '')
              when r.item_cd is not null then coalesce(nullif(btrim(coalesce(r.lct_cd, '')), ''), i.lct_cd)
              else i.lct_cd end as lct_cd
    from public.inv_audit_items i
    left join public.inv_parts p    on p.branch = v_branch and p.item_cd = i.item_cd
    left join public.inv_rr_parts r on r.branch = v_branch and r.item_cd = i.item_cd
   where i.audit_id = p_id and i.status is null;

  -- 1) 합계 0 → 목록에서 빼고 기록
  select coalesce(jsonb_agg(jsonb_build_object('item_cd', item_cd, 'item_nm', item_nm, 'lct_cd', old_lct,
           'qty', old_qty, 'rr_qty', old_rr, 'removed_at', now(), 'removed_by', public.inv_user_name()) order by old_lct, item_cd), '[]'::jsonb)
    into v_removed
    from _cur where qty = 0 and coalesce(rr_qty, 0) = 0;
  delete from public.inv_audit_items i using _cur c
   where i.audit_id = p_id and i.item_cd = c.item_cd and i.status is null and c.qty = 0 and coalesce(c.rr_qty, 0) = 0;

  -- 2) 나머지는 수량·위치 갱신
  update public.inv_audit_items i
     set qty = c.qty, rr_qty = c.rr_qty, lct_cd = c.lct_cd
    from _cur c
   where i.audit_id = p_id and i.item_cd = c.item_cd and i.status is null
     and (i.qty is distinct from c.qty or i.rr_qty is distinct from c.rr_qty or nullif(i.lct_cd, '') is distinct from c.lct_cd);
  get diagnostics v_changed = row_count;

  update public.inv_audits
     set qty_refreshed_at = now(), qty_refreshed_by_name = public.inv_user_name(),
         qty_basis_at = (select parts_at from public.inv_status where branch = v_branch),
         qty_removed = qty_removed || v_removed,
         item_count = (select count(*) from public.inv_audit_items where audit_id = p_id)
   where id = p_id;
  return jsonb_build_object('changed', v_changed, 'removed', jsonb_array_length(v_removed));
end;
$$;
revoke execute on function public.inv_refresh_audit(uuid) from public, anon;
grant execute on function public.inv_refresh_audit(uuid) to authenticated;
