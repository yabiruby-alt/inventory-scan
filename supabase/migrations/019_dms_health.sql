-- DMS 이상 표시: 데몬 프로그램은 살아 있는데 DMS 브라우저가 닫혔거나 로그인이 풀린 경우
--   데몬이 1분마다 확인해 이유를 남김 (정상이면 null). 앱은 이 값이 있으면 "연결됨" 대신 이유를 보여 주고 요청을 보내지 않음
alter table public.inv_status add column dms_error text;
