-- 재고조사 종료: 종료하면 더 이상 항목을 고칠 수 없고, 보고서(PDF)를 만든다

alter table public.inv_audits
  add column finished_at      timestamptz,
  add column finished_by      uuid references auth.users(id),
  add column finished_by_name text;

-- 같은 지점 직원 누구나 종료 (이미 종료됐으면 그대로 둠)
create function public.inv_finish_audit(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.inv_audits
     set finished_at = now(), finished_by = auth.uid(), finished_by_name = public.inv_user_name()
   where id = p_id and branch = public.inv_user_branch() and finished_at is null;
  if not found and not exists (select 1 from public.inv_audits where id = p_id and branch = public.inv_user_branch()) then
    raise exception '조사를 찾지 못했습니다';
  end if;
end;
$$;
revoke execute on function public.inv_finish_audit(uuid) from public, anon;
grant execute on function public.inv_finish_audit(uuid) to authenticated;

-- 종료된 조사의 항목은 못 고침
alter policy "직원 확인" on public.inv_audit_items
  using (exists (select 1 from public.inv_audits a where a.id = audit_id and a.branch = public.inv_user_branch() and a.finished_at is null))
  with check (exists (select 1 from public.inv_audits a where a.id = audit_id and a.branch = public.inv_user_branch() and a.finished_at is null));
