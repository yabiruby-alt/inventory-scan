# 통계 대시보드 "재고 관리" 메뉴 — 서버 쪽 인수인계

통계 대시보드(`dsm-stats-dashboard`)에 **재고 관리(DS재고 관리 앱)** 메뉴를 만들 때 쓰는 자료.
서버(Supabase `dongsung-parts-tablet`)와 로그인 계정은 입출고 통계와 같다. 2026-10-12 적용 (`supabase/migrations/021_inv_stats.sql`).

## 결정 사항
- 공개 범위: 입출고 통계와 같이 **사용 중인 모든 로그인 계정이 전 지점·이름까지** 본다.
- 스캔 수는 **일반 조회(스캔 탭)** 와 **재고조사 중** 을 따로 센다.
- 서버 통계에는 "누가·언제·몇 건·어떤 방식"만 있다. 부품번호·위치는 없다.
- 재고 표(`inv_*`)는 지점별로만 읽히므로, 대시보드는 표를 직접 읽지 말고 **아래 함수 3개(rpc)** 만 쓴다.
  모두 `security definer` 이고 `my_role()` 이 있는(사용 중인) 계정만 부를 수 있다. 날짜는 한국 날짜.

```ts
const { data } = await supabase.rpc("inv_stat_daily",  { p_from: "2026-10-01", p_to: "2026-10-31" });
const { data } = await supabase.rpc("inv_stat_active", { p_from: "2026-10-01", p_to: "2026-10-31" });
const { data } = await supabase.rpc("inv_stat_audits", { p_from: "2026-10-01", p_to: "2026-10-31" });
```
자료가 작아서(하루 수십 줄) 올해·누적도 넓은 기간으로 한 번에 받아 화면에서 묶으면 된다.

## 1) `inv_stat_daily(p_from, p_to)` — 일별 건수 (긴 표)
열: `stat_date, branch, user_key, user_name, metric, kind, via, result, n`
(`user_key` = 계정 id 문자열. 옛 자료 중 계정이 없는 것은 `name:이름`)

| metric | 뜻 | kind | via | result |
|---|---|---|---|---|
| `scan` | 스캔 수 | `lookup` 일반 조회 / `audit` 재고조사 중 | `scanner` 블루투스 스캐너 / `camera` 카메라 / `manual` 직접 입력·검색 | `part` 부품 / `loc` 위치 / `unknown` 목록에 없는 바코드 |
| `audit_check` | 재고조사 확인(작업 건수) | `daily` 일일 / `aging` 일일장기 / `weekly` 주간 | 현장 확인 방식: `scanner`·`camera`(위치를 찍음) / `part`(부품 바코드를 찍음) / `exempt`(예외, 사유 적음) / `unknown`(기능 생기기 전) | `ok` 일치 / `diff` 수량 다름 |
| `loc_change` | DMS 위치 변경 | `-` | `-` | `done` / `failed` / `cancelled` / `pending` / `running` |
| `rdc` | RDC 재고 조회 | `-` | `-` | `done` / `failed` / … |
| `check` | 수량 다름 체크 | `scan` 스캔 탭에서 / `audit` 재고조사에서 | `-` | `open` 남아 있음 / `cleared` 지움 |

- **스캔 수는 2026-10-12 배포(앱 v51)부터** 쌓인다. 그 전 스캔은 없다. 같은 바코드를 3초 안에 다시 찍은 것, Z 코드는 세지 않는다.
- `audit_check` 날짜는 확인 버튼을 누른 시각(`marked_at`, 없으면 서버 기록 시각) 기준. 확인을 되돌리면 건수에서 빠진다.
- "하루 작업 건수" = 그날 `audit_check` 합계(+ 원하면 `loc_change` done, `check`).

## 2) `inv_stat_active(p_from, p_to)` — 재고조사 작업시간
열: `stat_date, branch, user_key, user_name, checks, active_sec, first_at, last_at`
- 한 사람의 하루 재고조사 확인 시각들 사이 간격의 합(초). **간격이 5분을 넘으면 그 시간은 뺀다** (입출고 통계와 같은 규칙).
- 시간당 처리 = `checks / (active_sec / 3600)`. 확인이 1건뿐인 날은 0초.
- 스캔 탭 조회 시간은 들어 있지 않다(시각을 올리지 않음).

## 3) `inv_stat_audits(p_from, p_to)` — 조사별 요약
열: `audit_id, branch, kind, period_start, period_end, started_at, started_by_name, finished_at, finished_by_name, total, ok, diff, unchecked, exempt, removed_zero, workers`
- 기간 조건은 `period_start`(조사 날짜, 주간은 그 주 월요일) 기준.
- **일일 재고조사를 누적 며칠 했는지** = `kind='daily'` 이고 `ok + diff > 0` 인 조사 수 (지점별). 종료까지 한 날만 세려면 `finished_at is not null`.
- 완료율 = `(ok + diff) / total`. `unchecked` = 미확인, `exempt` = 예외로 확인한 건수, `removed_zero` = DMS 갱신 때 재고 0으로 목록에서 뺀 건수, `workers` = 참여 인원.
- 일일장기(`aging`)는 하루 10건 무작위(확인 안 한 것은 다음 날 이월).

## 참고
- 원본 건수 표 `inv_stat_counts`(스캔 수)는 모든 계정이 읽을 수 있지만, 위 함수로 충분하다. 쓰기는 앱의 `inv_stat_push` 로만.
- 지금 앱을 쓰는 지점은 해운대뿐이다(2026-10-12). 다른 지점은 자료가 없다.
- **용량 정리(2026-10-12, `022_storage_compact.sql`)**: 조사 기간이 90일 지난 재고조사는 부품별 상세를 지우고 통계 숫자만 남긴다.
  위 함수 3개는 정리 전·후 자료를 합쳐서 돌려주므로 **대시보드 쪽은 신경 쓸 것이 없다** (정리 전후 값이 같음을 시험함).
- RDC 조회·위치 변경 기록은 지우지 않는다(RDC 는 7일 뒤 결과 내용만 비움). 자동 실시간 조회(`stock`) 기록은 3일 뒤 지운다(통계에 안 씀).
- 앱 저장소: `yabiruby-alt/inventory-scan` (공개). 앱 쪽 집계 코드는 `app.js` 의 "통계: 스캔 수" 부분.
