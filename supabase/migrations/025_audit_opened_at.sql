-- 재고조사 확인 창을 연 시각: 보고서 "걸린시간" = 재고 확인 창을 연 때부터 확인(일치·수량 다름)을 누른 때까지
--   (예전에는 위치·부품을 찍은 때부터 확인까지라서, 찍어 놓고 나중에 누르거나 수량 다름을 고쳐 다시 누르면 시간이 부풀려졌다)
--   opened_at  그 부품의 재고 확인 창을 연 시각 (휴대폰 시계). 이 열이 생기기 전 기록은 비어 있고 보고서에 '-' 로 나온다

alter table public.inv_audit_items
  add column if not exists opened_at timestamptz;

grant update (opened_at) on public.inv_audit_items to authenticated;
