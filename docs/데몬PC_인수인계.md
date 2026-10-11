# 데몬 PC 인수인계 (2026-10-11)

회사 PC에서 24시간 도는 **파츠베이 데몬(`partsbay.py`)** 최적화를 새 세션에서 진행하기 위한 정리.
앱(휴대폰 재고조사 `inventory-scan`) 개발 세션에서 넘겨받은 내용이다. 대화·주석·커밋은 모두 한글.

---

## 1. 데몬 PC에 무엇이 돌고 있나

```
회사 PC (Windows)
└─ partsbay.py  (저장소 yabiruby-alt/dsparts-hd, 폴더 이름 예: ...\dsparts-hd)
   ├─ BMW DMS 창 (Playwright, 로그인 유지, 최소화)      ← page
   ├─ RR(롤스로이스) DMS 창 (별도 계정·세션)            ← rr_page
   ├─ 10분마다 run_cycle(page, rr_page)
   │    1) DMS 10여 개 화면을 메뉴 클릭 → 화면 대기 → jQuery POST 로 데이터 받음 (순서대로)
   │    2) 파츠베이 대시보드 생성 → docs/ → GitHub Pages 로 자동 push (매 주기 커밋)
   │    3) 매출 대시보드: ..\업무자동화 생성\매출데이터 사이트\sales.py (page, rr_page 사용)
   │    4) 재고조사 앱: ..\재고조사 어플\daemon\stockapp.py on_cycle() → Supabase 업로드
   ├─ 쉬는 10분 동안 1초마다
   │    - serve_stock_requests(): 로컬 HTTP /stock 요청 처리
   │    - serve_stockapp_requests(): stockapp.poll() → 앱 요청(현재고·RDC 조회, 위치 변경) 처리
   └─ 로컬 HTTP 서버 127.0.0.1:8765 (스레드)
        /stock?pn=…  (파츠베이 대시보드 사이트에서 부품 재고 조회, 메인 스레드 큐로 넘김, 240초 대기)
        /reasons     (진행 RO 사유 입력·조회)
        /            (이 PC 전용 로컬 대시보드)
```

### 데몬 PC에 영향을 받는 것 (= 데몬을 바꾸면 같이 확인해야 할 것)
| 대상 | 무엇에 의존 | 저장소 / 위치 |
|---|---|---|
| 파츠베이 대시보드 (GitHub Pages) | run_cycle 데이터, 매 주기 push | `yabiruby-alt/dsparts-hd` (docs/) |
| 매출 대시보드 (지점장 전용, 암호화 페이지) | run_cycle 안의 `sales.run(...)`, BMW·RR 창 | PC 폴더 `업무자동화 생성\매출데이터 사이트\sales.py` (**GitHub 에 코드 없음**, 결과만 `yabiruby-alt/ds-sales`) |
| 재고조사 앱 (휴대폰) | `stockapp.py` on_cycle 업로드 + poll 요청 처리 | `yabiruby-alt/inventory-scan` (daemon/stockapp.py), Supabase `qswzxudtzjuheugdnuoc` |
| 대시보드 사이트의 부품 재고 조회 | 로컬 HTTP `/stock` (STOCK_QUEUE) | partsbay.py |
| 진행 RO 사유 입력 | 로컬 HTTP `/reasons` | partsbay.py |
| 태블릿 입출고 앱 (`dsm-tablet-app`) | **데몬과 무관** (같은 Supabase 프로젝트만 공유) | — |

### 관련 Claude 세션
| 세션 | 내용 | 데몬 관련 |
|---|---|---|
| DS 재고관리어플 개발 (클라우드, 지금 세션) | 재고조사 앱 + `stockapp.py` | stockapp.py 를 고침. **데몬 쪽 작업은 새 세션으로 넘김** |
| 통계 대시보드 개발 (PC) | 태블릿 입출고 스캔 통계 | 무관 |
| 깃허브 태블릿에서 입출고 시스템 수정 (클라우드) | 태블릿 앱 | 무관 |
| DMS 사이트 데이터 추출 가능성 (PC, 보관됨, 9/10) | partsbay 의 시작: DMS 화면별 그리드·read URL·jQuery ajax 캡처 조사 | 참고 (메뉴 없이 직접 요청 시험은 **없음**) |
| `partsbay.py`·`sales.py` 개발 세션 | 기록 없음 (PC 로컬 작업, dsparts-hd 커밋은 전부 자동 "대시보드 갱신") | — |

---

## 2. 꼭 알아야 할 주의사항

1. **DMS 로그인은 2단계 인증 → 데몬 재시작 = 사람이 PC 앞에서 다시 로그인.** 재시작이 필요한 변경은 한 번에 모아서.
2. **DMS 세션은 하나만.** 시험용 Playwright 를 따로 띄우면 같은 계정 로그인이 겹쳐 데몬 세션이 끊길 수 있다 (`.partsbay.lock` 으로 중복 실행도 막음). 시험은 **데몬 프로세스 안에서** 해야 한다.
3. **`partsbay.py` 는 데몬이 매 주기 직접 커밋·push 한다** (`publish_to_github` 가 `git add docs partsbay.py …`). 다른 곳(클라우드 세션)에서 dsparts-hd 에 push 하면 데몬 push 와 충돌한다 → **partsbay.py 수정은 데몬 PC 에서 직접** 하고 데몬이 올리게 하거나, 데몬을 멈춘 상태에서 pull/merge.
4. **재시작 없이 바뀌는 것:** `stockapp.py` (매 주기 `importlib.reload`), `sales.py` (매 주기 reload). **재시작 필요:** `partsbay.py`.
5. Playwright sync API → **한 번에 한 작업.** 스레드에서 page 를 쓰면 안 된다 (그래서 /stock 도 큐로 메인 스레드에 넘김).
6. 위치 변경(`stockapp._loc_change`)은 재고마스터 화면을 실제로 조작·저장한다. 저장 후 다른 칸이 바뀌면 `재고조사 어플\daemon\LOC_CHANGE_HALT.txt` 를 만들고 멈춘다. (10/7 `preSplyCd`·`sftyStockPrid` 오탐 → 커밋 bb37844 로 허용, 이후 정상)
7. 비밀번호·토큰은 받지도 다루지도 않는다. `config.local.json` 은 GitHub 에 올리지 않는다.
8. Supabase: 읽기는 바로, **쓰기(SQL·마이그레이션)는 무엇을 할지 말하고 허락받은 뒤.**

---

## 3. 현재 상태 (10/8 기준 운영 기록)

- 갱신 주기: 대시보드 커밋 간격 약 12분 30초 → **갱신 한 번 약 2분 30초** + 쉬기 10분.
- 앱의 "지금 DMS 조회"(요청 `stock`): 보통 1~2초, **갱신 중에 들어오면 최대 118초** (쉬는 시간에만 처리하기 때문).
- RDC 조회 26건 모두 성공 — `selectRdcPartsPopup.do`(원래 판매 화면 팝업용)를 **현재고리스트 화면에서** 보내도 된다는 증거. 즉 DMS 가 "그 메뉴 화면에서 보낸 요청만" 받는 엄격한 검사를 적어도 이 요청엔 하지 않음.
- 위치 변경: 10/7 15:25 이후 3건 모두 정상.
- 데몬은 지금 정상 동작 중 (10/12 07:53 KST 응답, 현재고·RR 업로드 정상, rr_error 없음).

---

## 4. 할 일 (순서대로)

### ① 갱신 단계별 시간 측정 (위험 없음)
- `run_cycle` 각 단계(입고현황, 현재고리스트, Turn Over 당월, 출고요청, RO, 예약 노쇼/접수, 차량접수 SB, 당월 입고, 지난주 Turn Over, 매출, 재고조사 앱, GitHub push)에 걸린 초를 데몬 창에 출력.
- partsbay.py 수정 → 재시작 필요 (다른 변경과 묶어서).

### ② "메뉴 없이 + 동시 요청" 시험 (데몬 안에서, 조회만)
- 방법: `stockapp.py` 에 **하루 한 번만 도는 시험 코드**를 넣는다 (재시작 없이 git pull 만으로 반영).
  - 갱신 직후, 이미 열린 현재고리스트 화면(`selectInventListMain`) 하나에서
    입고현황·Turn Over·출고요청·RO 리포트·서비스예약 요청을 **메뉴를 열지 않고** 보낸다.
    (간단한 방법: 시험 동안만 `pb.click_menu` 를 아무것도 안 하게, `pb.wait_for_frame` 이 그 화면을 돌려주게 바꿔 `pb.extract_*` 를 그대로 부르고, finally 에서 원래대로)
  - 각 요청 성공 여부·건수·걸린 초를 방금 정상 방식 결과와 비교.
  - 같은 요청들을 한 화면에서 `Promise.all` 로 **동시에** 보냈을 때 걸린 시간.
  - 아무것도 저장·변경하지 않음. 실패해도 갱신에 영향 없게 예외 처리.
  - 결과는 데몬 창 + Supabase 에 남겨 원격에서 확인 (예: `inv_daemon_diag` 표 — 마이그레이션은 허락받고).

### ③ 결과에 따라 적용 (partsbay.py, 재시작 1번)
- 메뉴 없이 되는 요청은 한 화면에서 동시 요청으로 → 갱신 2분 30초 → 예상 30~60초.
- 갱신 중에도 앱 요청 처리 (단계 사이에 `serve_stockapp_requests` / `serve_stock_requests`):
  - 갱신 중엔 **현재고·RDC 조회만**, 위치 변경은 갱신 끝난 뒤 (화면 조작이라 갱신 화면을 꼬이게 할 수 있음).
  - 갱신 중엔 이미 열린 현재고 화면만 사용 (메뉴 클릭 금지, 탭 늘어남 방지).
  - **덮어쓰기 방지:** 갱신 2단계에서 받은 현재고(pw_rows)가 마지막 on_cycle 에서 올라갈 때, 그 사이 직접 조회한 부품의 더 새 값을 옛 값으로 덮지 않게 (`stockapp._S.parts_sent` 와 조회 시각 비교).
- 자주 안 바뀌는 데이터는 덜 자주: 지난주 Turn Over 하루 1번, 노쇼 SB(2020년~) 1시간, 당월 입고 30분 (대시보드 표시 요구는 사용자 확인).
- 오래 켜 둔 창 정리: 매일 새벽 한 번 창 새로고침(로그인 유지 확인), 쓴 탭 정리.

### ④ 그 뒤 앱 쪽 (앱 세션에서)
- 현재고를 3~5분마다 따로 올리기 등 데몬이 빨라진 만큼 앱 반영.

---

## 5. 참고 위치
- `partsbay.py`: `run_cycle`(약 1520행), `click_menu`·`wait_for_frame`·`FETCH_JS`(157~206행), `lookup_stock`(207행), 대기 루프(1703행~), HTTP 서버(`ReasonHandler`, 1456행~)
- `inventory-scan/daemon/stockapp.py`: `on_cycle`, `poll`, `_handle`, `_lookup`(RDC 포함), `_lookup_own`(현재고만, 열린 화면 재사용), `_loc_change`, `_upload_rr`
- `inventory-scan/README.md`: 앱·데몬 연동 설명
- Supabase 표: `inv_status`(데몬 응답·업로드 시각·rr_error), `inv_requests`(앱 요청 큐), `inv_parts`, `inv_rr_parts`, `inv_audit_source`
