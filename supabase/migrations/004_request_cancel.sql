-- 데몬이 멈춘 동안 쌓인 요청이 나중에 한꺼번에 처리되지 않게
--   앱: 기다리다 포기한 요청은 inv_cancel_request() 로 취소
--   데몬: 오래된 대기 요청은 처리하지 않고 취소로 정리

alter table public.inv_requests drop constraint inv_requests_status_check;
alter table public.inv_requests add constraint inv_requests_status_check
  check (status in ('pending', 'running', 'done', 'failed', 'cancelled'));

-- 직원은 자기가 보낸 대기 중 요청만 취소 (이미 데몬이 가져간 요청은 못 함 → false)
create function public.inv_cancel_request(p_id bigint) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.inv_requests
     set status = 'cancelled', error = '응답이 없어 취소했습니다', finished_at = now()
   where id = p_id and status = 'pending'
     and requested_by = auth.uid() and branch = public.inv_user_branch();
  return found;
end;
$$;
revoke execute on function public.inv_cancel_request(bigint) from public, anon;
grant execute on function public.inv_cancel_request(bigint) to authenticated;
