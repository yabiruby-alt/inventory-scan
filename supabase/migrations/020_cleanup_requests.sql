-- 오래된 조회 요청 기록 정리: RDC 조회·현재고 조회(실시간 조회가 자동이 되어 빨리 쌓임)는 30일 지나면 지움
--   위치 변경(loc_change) 기록은 이력 화면에 쓰므로 지우지 않음. 데몬이 하루 한 번 부름
create function public.inv_cleanup_requests(p_days integer default 30) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_branch text := public.inv_daemon_branch();
  v_n      integer;
begin
  if v_branch is null then
    raise exception '데몬 계정이 아닙니다';
  end if;
  delete from public.inv_requests
   where branch = v_branch and kind in ('rdc', 'stock')
     and requested_at < now() - make_interval(days => greatest(p_days, 7));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function public.inv_cleanup_requests(integer) from public, anon;
grant execute on function public.inv_cleanup_requests(integer) to authenticated;
