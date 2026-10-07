-- 재고조사 다시 시작: 잘못 눌러 종료한 조사를 다시 열어 종료 전 상태 그대로 이어서 확인
--   확인한 내용(항목·체크 기록)은 그대로 두고 종료 표시만 지움. 마지막으로 다시 연 시각·사람은 남김

alter table public.inv_audits
  add column reopened_at      timestamptz,
  add column reopened_by_name text;

create function public.inv_reopen_audit(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.inv_audits
     set finished_at = null, finished_by = null, finished_by_name = null,
         reopened_at = now(), reopened_by_name = public.inv_user_name()
   where id = p_id and branch = public.inv_user_branch() and finished_at is not null;
  if not found and not exists (select 1 from public.inv_audits where id = p_id and branch = public.inv_user_branch()) then
    raise exception '조사를 찾지 못했습니다';
  end if;
end;
$$;
revoke execute on function public.inv_reopen_audit(uuid) from public, anon;
grant execute on function public.inv_reopen_audit(uuid) to authenticated;
