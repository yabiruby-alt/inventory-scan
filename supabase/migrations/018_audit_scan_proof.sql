-- 재고조사 현장 확인 기록: 일치·수량 다름을 누르기 전에 위치(또는 부품 바코드)를 스캐너·카메라로 찍어야 함 (앱에서 막음)
--   loc_via        어떻게 열었는지: scanner(블루투스 스캐너로 위치) / camera(카메라로 위치) / part(부품 바코드 스캔) / exempt(예외 — 사유 필수)
--   loc_scanned_at 그 위치(부품)를 마지막으로 찍은 시각 (휴대폰 시계)
--   marked_at      확인 버튼을 누른 시각 (휴대폰 시계 — 전파 약한 곳에서 늦게 보내도 실제 누른 시각)
--   exempt_reason  예외로 확인한 사유
--   보고서에서 예외·스캔 뒤 오래 지나 확인·너무 빠른 연속 확인을 따로 표시

alter table public.inv_audit_items
  add column loc_via text check (loc_via in ('scanner', 'camera', 'part', 'exempt')),
  add column loc_scanned_at timestamptz,
  add column marked_at timestamptz,
  add column exempt_reason text;

grant update (loc_via, loc_scanned_at, marked_at, exempt_reason) on public.inv_audit_items to authenticated;
