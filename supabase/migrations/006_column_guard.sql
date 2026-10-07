-- 직원 계정이 바꿀 수 있는 칸을 좁힘 (앱 밖에서 직접 API를 불러도 기록이 흐트러지지 않게)

-- 재고조사 항목: 확인 결과(상태·실사 수량·메모)만. DMS 수량·품번·품명·위치는 조사 시작 때 고정
revoke update on public.inv_audit_items from authenticated;
grant update (status, counted, memo) on public.inv_audit_items to authenticated;

-- 체크 기록: 품번·품명·위치·조사·지점은 못 바꿈
revoke update on public.inv_checks from authenticated;
grant update (dms_qty, counted_qty, memo, checked_at, checked_by, checked_by_name, cleared_at, cleared_by_name)
  on public.inv_checks to authenticated;

-- 고친 사람·지운 사람은 서버가 채움 (앱이 보낸 이름·시각은 무시)
create function public.inv_stamp_check_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.counted_qty is distinct from old.counted_qty or new.memo is distinct from old.memo
     or new.dms_qty is distinct from old.dms_qty then
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
create trigger inv_checks_stamp_update before update on public.inv_checks
  for each row execute function public.inv_stamp_check_update();
revoke execute on function public.inv_stamp_check_update() from public, anon, authenticated;
