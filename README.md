# DS재고 관리

휴대폰으로 위치·부품 바코드를 스캔해 DMS 부품창고 현재고와 RDC 재고를 조회하고, 재고조사를 하는 앱.

- 앱: https://yabiruby-alt.github.io/inventory-scan/ (홈 화면에 추가해서 사용)
- 화면 시안: `시안/prototype.html` (예시 데이터)

## 구조
```
파츠베이 데몬(이 PC, partsbay.py) ──10분마다──▶ Supabase inv_parts / inv_audit_source / inv_status
휴대폰 앱 ──요청──▶ inv_requests ──3초마다──▶ 데몬이 DMS에서 처리 (RDC 조회, 현재고 조회, 위치 변경)
휴대폰 앱 ──▶ inv_checks (수량 다름), inv_audits / inv_audit_items (재고조사)
```
- 로그인: 태블릿 입출고 앱과 같은 계정 (Supabase 프로젝트 `dongsung-parts-tablet` 공유, 테이블은 모두 `inv_` 로 시작)
- 앱: 빌드 없는 `index.html` + `app.js` + `app.css`. 바코드는 ZXing, DB는 supabase-js (CDN)
- 데몬 연동: `daemon/stockapp.py` — partsbay.py 가 매 주기 다시 읽으므로 고쳐도 데몬 재시작 불필요
- DB 변경: `supabase/migrations/`

## 데몬 설정
`daemon/config.example.json` 을 `daemon/config.local.json` 으로 복사하고 데몬 전용 계정 비밀번호를 넣는다.
`config.local.json` 은 깃허브에 올라가지 않는다.

## DMS 위치 변경
재고마스터 화면에서 사람이 하는 순서 그대로 처리한다 (조회 → 줄 선택 → 로케이션코드만 수정 → 저장).
저장 전에 로케이션코드 말고 바뀌는 값이 없는지, 저장 후 다시 조회해 다른 항목이 바뀌지 않았는지 확인한다.
이상이 감지되면 `daemon/LOC_CHANGE_HALT.txt` 가 생기고 위치 변경을 멈춘다. 원인을 확인한 뒤 이 파일을 지우면 다시 동작한다.

## 데몬이 멈췄을 때
- 앱은 DMS 연결 PC 응답이 3분 넘게 없으면 RDC 조회·현재고 조회·위치 변경 요청을 보내지 않는다.
- 보낸 요청이 10분 동안 처리되지 않으면 앱이 취소한다 (`inv_cancel_request`). 데몬도 10분 지난 대기 요청은 처리하지 않고 `cancelled` 로 정리한다.
  → 데몬을 다시 켰을 때 예전 위치 변경이 뒤늦게 DMS에 저장되지 않는다.

## 시험
`node tests/app.test.js` — 가짜 Supabase 응답으로 실제 브라우저에서 앱을 돌려 봄 (준비 방법은 파일 위 주석).
위치 검색어 유지, 현재고 바뀐 것만 받기, 전파 끊김 시 재고조사 저장·재전송, 체크 기록 중복 방지, 데몬 멈춤 안내, 위치 변경 이력 화면을 확인한다.

## 정해진 규칙
- 위치: 영문 1 + 숫자 6 (`A140112`), 그리고 `4F FLOOR` 형태. 그 외 형식은 쓰지 않음
- Z로 시작하는 서비스 코드 품번은 제외
- 품번·위치는 띄어쓰기 없이 라벨 그대로 표시
- 같은 바코드는 3초 동안 다시 읽지 않음
- 스캔 영역은 화면 위에 고정, 결과는 그 아래에 표시
- 재고조사 목록은 조사 시작 시점에 고정, 수량이 맞으면 "일치" 한 번
