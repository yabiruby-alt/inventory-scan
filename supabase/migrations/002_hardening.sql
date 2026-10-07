-- 보안 점검(advisors) 결과 반영

-- 트리거 전용 함수는 API로 직접 호출하지 못하게
revoke execute on function public.inv_stamp_checker(), public.inv_stamp_request(), public.inv_stamp_check() from public, anon, authenticated;

-- auth.uid() 를 행마다 다시 계산하지 않도록
drop policy "직원 등록" on public.inv_requests;
create policy "직원 등록" on public.inv_requests for insert to authenticated
  with check (branch = public.inv_user_branch() and requested_by = (select auth.uid()) and status = 'pending');

drop policy "직원 등록" on public.inv_checks;
create policy "직원 등록" on public.inv_checks for insert to authenticated
  with check (branch = public.inv_user_branch() and checked_by = (select auth.uid()));
