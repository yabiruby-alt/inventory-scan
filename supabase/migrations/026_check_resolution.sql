-- 수량 다름 체크(inv_checks)의 처리 결과: 체크 기록을 정리할 때 어떻게 처리했는지 남김
--   adjusted   재고 정정함 (DMS 재고를 실사 수량으로 정정)
--   explained  원인 확인 (다른 곳 보관·미입고 등 원인을 확인했고 실사 수량이 맞음)
--   miscount   잘못 센 것 (DMS 수량이 맞음)
--   비어 있으면: 조사에서 일치로 바꾸면서 자동으로 정리됐거나, 이 열이 생기기 전에 정리한 기록
--   앱의 체크 기록 화면 "처리 완료 기록"에서 보여 주고, 다음 조사 보고서의 "지난 수량 다름 재확인"과 함께 후속 관리에 씀

alter table public.inv_checks
  add column if not exists resolution text check (resolution in ('adjusted', 'explained', 'miscount'));

grant update (resolution) on public.inv_checks to authenticated;
