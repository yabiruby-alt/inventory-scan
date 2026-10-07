"""재고조사 앱 ↔ 파츠베이 데몬 연동.

partsbay.py 가 매 주기 importlib.reload 로 다시 읽으므로, 이 파일을 고쳐도 데몬 재시작(=DMS 재로그인)이 필요 없다.
DMS 세션은 데몬 것 하나만 쓴다 (같은 계정으로 세션을 두 개 띄우면 DMS가 끊어버림).

  on_cycle(page, ctx)  10분 주기 끝에 호출: 부품창고 현재고 / 일일·주간 재고조사 목록 / 상태를 Supabase에 올림
  poll(page)           주기 사이 대기 중 1초마다 호출: 앱이 보낸 요청(RDC 조회, 현재고 조회, 위치 변경)을 처리

설정: 같은 폴더의 config.local.json (깃허브에 올리지 않음)
  {"url": "...", "key": "sb_publishable_...", "email": "inventory-daemon@tablet.dongsung.local",
   "password": "...", "branch": "해운대", "dealer_cd": "001672", "brch_cd": "15"}
  선택: "rr": {"corp_cd": "...", "biz_area_cd": "...", "brch_cd": "..."}  RR DMS 지점 코드 (없으면 RR 화면 검색칸 값을 씀)

RR(롤스로이스) 재고: partsbay.py 가 BMW 창과 함께 RR DMS 창(rr_page)도 띄워 두므로, 10분 주기에 그 창으로
RR 부품창고 현재고를 받아 inv_rr_parts 로 올림. RR 이 실패해도 BMW 업로드에는 영향 없음.
"""
import inspect
import json
import re
import sys
import time
import types
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "config.local.json"
LOC_HALT = HERE / "LOC_CHANGE_HALT.txt"   # 이 파일이 있으면 위치 변경을 멈춤 (이상 감지 시 자동 생성)

POLL_EVERY_SEC = 3
HEARTBEAT_EVERY_SEC = 60
LOGIN_RETRY_SEC = 120
REQ_EXPIRE_SEC = 600      # 이보다 오래 기다린 요청은 처리하지 않음 (앱도 10분 기다리다 취소)
LOC_RE = re.compile(r"^(?:[A-Z]\d{6}|\d+F FLOOR)$")

# 모듈을 reload 해도 유지할 상태 (로그인 토큰, 마지막 업로드 내용)
_S = sys.modules.get("_stockapp_state")
if _S is None:
    _S = types.ModuleType("_stockapp_state")
    _S.token = None
    _S.refresh = None
    _S.expires_at = 0.0
    _S.login_fail_at = 0.0
    _S.last_poll = 0.0
    _S.last_beat = 0.0
    _S.parts_sent = {}       # item_cd -> 마지막으로 올린 행 (바뀐 것만 올리기)
    _S.lists_sent = {}       # kind -> 마지막으로 올린 목록
    _S.rr_sent = {}          # RR 현재고: item_cd -> 마지막으로 올린 행
    sys.modules["_stockapp_state"] = _S
if not hasattr(_S, "rr_sent"):   # 이 항목이 생기기 전부터 떠 있던 데몬
    _S.rr_sent = {}


def _log(msg: str) -> None:
    print(f"   [재고조사 앱] {msg}")


def _cfg() -> dict:
    return json.loads(CONFIG.read_text(encoding="utf-8"))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ------------------------------------------------------------
# Supabase (표준 라이브러리만 사용)
# ------------------------------------------------------------

def _http(method: str, url: str, headers: dict, body=None, timeout: int = 30):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw[:500]


def _auth(grant: str, body: dict) -> bool:
    c = _cfg()
    status, res = _http("POST", f"{c['url']}/auth/v1/token?grant_type={grant}",
                        {"apikey": c["key"], "Content-Type": "application/json"}, body)
    if status == 200 and isinstance(res, dict) and res.get("access_token"):
        _S.token = res["access_token"]
        _S.refresh = res.get("refresh_token")
        _S.expires_at = time.time() + int(res.get("expires_in", 3600))
        return True
    _log(f"Supabase 로그인 실패 ({grant}): {status} {str(res)[:200]}")
    return False


def _ensure_token() -> bool:
    if _S.token and time.time() < _S.expires_at - 120:
        return True
    if _S.refresh and _auth("refresh_token", {"refresh_token": _S.refresh}):
        return True
    if time.time() - _S.login_fail_at < LOGIN_RETRY_SEC:
        return False
    c = _cfg()
    if _auth("password", {"email": c["email"], "password": c["password"]}):
        return True
    _S.token = None
    _S.login_fail_at = time.time()
    return False


def _rest(method: str, path: str, body=None, prefer: str = "return=minimal"):
    c = _cfg()
    headers = {"apikey": c["key"], "Authorization": f"Bearer {_S.token}",
               "Content-Type": "application/json", "Prefer": prefer}
    status, res = _http(method, f"{c['url']}/rest/v1/{path}", headers, body)
    if status == 401:   # 토큰 만료 → 한 번 다시 로그인
        _S.token = None
        if _ensure_token():
            headers["Authorization"] = f"Bearer {_S.token}"
            status, res = _http(method, f"{c['url']}/rest/v1/{path}", headers, body)
    if status >= 300:
        raise RuntimeError(f"Supabase {method} {path.split('?')[0]} 실패 {status}: {str(res)[:300]}")
    return res


def _q(v: str) -> str:
    return urllib.parse.quote(str(v), safe="")


# ------------------------------------------------------------
# 10분 주기: 현재고 / 재고조사 목록 / 상태 업로드
# ------------------------------------------------------------

def _num(v) -> float:
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return 0.0


def _part_row(branch: str, r: dict) -> dict:
    return {
        "branch": branch,
        "item_cd": r.get("itemCd"),
        "item_nm": r.get("itemNm"),
        "lct_cd": (r.get("lctCd") or "").strip() or None,
        "crt_qty": _num(r.get("crtQty")),
        "alois_cd": r.get("aloisCd"),
        "last_purc_dt": (r.get("lastPurcDt") or "")[:10] or None,
    }


def _list_items(rows: list) -> list:
    out = []
    for r in rows:
        item = r.get("item") or ""
        if not item or item.startswith("Z"):
            continue
        loc = r.get("loc") or ""
        out.append({"item_cd": item, "item_nm": r.get("name"), "lct_cd": "" if loc == "-" else loc,
                    "qty": r.get("qty"), "alois_cd": r.get("alois")})
    return out


def _upload_parts(table: str, sent_attr: str, branch: str, pw_rows: list, now: str):
    """부품창고 현재고: 바뀐 행만 올리고, 없어진 품번은 지움 (Z 코드 제외)"""
    sent = getattr(_S, sent_attr)
    rows = {}
    for r in pw_rows:
        cd = r.get("itemCd")
        if cd and not cd.startswith("Z"):
            rows[cd] = _part_row(branch, r)
    if not sent:   # 데몬 시작 후 처음: 서버에 있는 것과 비교할 기준이 없으니 전부 올림
        changed = list(rows.values())
    else:
        changed = [v for k, v in rows.items() if sent.get(k) != v]
    for i in range(0, len(changed), 500):
        chunk = [dict(v, updated_at=now) for v in changed[i:i + 500]]
        _rest("POST", f"{table}?on_conflict=branch,item_cd", chunk, "resolution=merge-duplicates,return=minimal")
    if not sent:
        # 처음: 이번에 올리지 않은 품번(예전 주기의 잔여)은 지움
        _rest("DELETE", f"{table}?branch=eq.{_q(branch)}&updated_at=lt.{_q(now)}")
    else:
        removed = [k for k in sent if k not in rows]
        for i in range(0, len(removed), 100):
            ids = ",".join(f'"{x}"' for x in removed[i:i + 100])
            _rest("DELETE", f"{table}?branch=eq.{_q(branch)}&item_cd=in.({_q(ids)})")
    setattr(_S, sent_attr, rows)
    return rows, changed


def on_cycle(page, ctx: dict) -> None:
    """ctx: pw_rows(부품창고 현재고 원본), stockcheck, stockcheck_week, today(YYYY-MM-DD)"""
    if not CONFIG.exists():
        _log("config.local.json 이 없어 건너뜀")
        return
    if not _ensure_token():
        return
    branch = _cfg()["branch"]
    now = _now_iso()

    # 1) 부품창고 현재고
    rows, changed = _upload_parts("inv_parts", "parts_sent", branch, ctx["pw_rows"], now)

    # 2) 재고조사 원본 목록
    sc, sw = ctx["stockcheck"], ctx["stockcheck_week"]
    lists = {
        "daily": {"branch": branch, "kind": "daily", "period_start": sc["date"], "period_end": sc["date"],
                  "items": _list_items(sc["rows"])},
        "weekly": {"branch": branch, "kind": "weekly", "period_start": sw["start"], "period_end": sw["end"],
                   "items": _list_items(sw["rows"])},
    }
    for kind, body in lists.items():
        if _S.lists_sent.get(kind) != body:
            _rest("POST", "inv_audit_source?on_conflict=branch,kind", dict(body, updated_at=now),
                  "resolution=merge-duplicates,return=minimal")
            _S.lists_sent[kind] = body

    # 3) 상태
    _rest("POST", "inv_status?on_conflict=branch",
          {"branch": branch, "parts_at": now, "lists_at": now, "daemon_seen_at": now},
          "resolution=merge-duplicates,return=minimal")
    _S.last_beat = time.time()
    _log(f"업로드: 현재고 {len(rows)}건 (변경 {len(changed)}건), 일일 {len(lists['daily']['items'])}건, 주간 {len(lists['weekly']['items'])}건")

    # 4) RR 현재고 (실패해도 BMW 쪽은 이미 끝남)
    try:
        n = _upload_rr(ctx, branch, now)
        _rest("PATCH", f"inv_status?branch=eq.{_q(branch)}", {"rr_parts_at": now, "rr_error": None})
        _log(f"업로드: RR 현재고 {n}건")
    except Exception as e:
        msg = str(e)[:300]
        _log(f"RR 현재고 실패: {msg}")
        try:
            _rest("PATCH", f"inv_status?branch=eq.{_q(branch)}", {"rr_error": msg})
        except Exception:
            pass


# ------------------------------------------------------------
# RR(롤스로이스) DMS 부품창고 현재고
# ------------------------------------------------------------

def _rr_page(ctx: dict):
    """partsbay 가 넘겨준 RR DMS 창. ctx 에 없으면 on_cycle 을 부른 run_cycle(page, rr_page) 의 rr_page 를 씀
    (partsbay.py 를 고치거나 재시작하지 않아도 되게)"""
    if ctx.get("rr_page") is not None:
        return ctx["rr_page"]
    f = inspect.currentframe()
    try:
        for _ in range(6):
            f = f.f_back
            if f is None:
                return None
            if "rr_page" in f.f_locals:
                return f.f_locals["rr_page"]
        return None
    finally:
        del f


_RR_CODES_JS = """() => {
  const v = (id) => { const el = document.getElementById(id); return el ? String(el.value || "").trim() : ""; };
  return {corp_cd: v("sCorpCd"), biz_area_cd: v("sBizAreaCd"), brch_cd: v("sBrchCd")};
}"""


def _upload_rr(ctx: dict, branch: str, now: str) -> int:
    import __main__ as pb   # partsbay.py 의 DMS 함수 사용 (RR 도 같은 My DMS 화면)
    rp = _rr_page(ctx)
    if rp is None:
        raise RuntimeError("RR DMS 창이 없습니다 (partsbay 의 RR 연동이 꺼져 있음)")
    try:
        pb.click_menu(rp, "icon-parts", "현재고리스트 조회")
    except Exception as e:
        raise RuntimeError(f"RR DMS 메뉴를 열지 못했습니다 — RR DMS 로그인 확인 필요 ({type(e).__name__})")
    frame = pb.wait_for_frame(rp, "selectInventListMain")
    codes = _cfg().get("rr") or {}
    if not all(codes.get(k) for k in ("corp_cd", "biz_area_cd", "brch_cd")):
        rp.wait_for_timeout(1500)   # 검색칸이 채워질 때까지
        codes = frame.evaluate(_RR_CODES_JS)
    if not codes.get("corp_cd"):
        raise RuntimeError(f"RR 지점 코드를 알 수 없습니다 (설정 파일에 rr 코드를 넣어 주세요): {codes}")
    body = {
        "recordCountPerPage": 200000, "pageIndex": 1, "firstIndex": 0, "lastIndex": 200000,
        "sCorpCd": codes["corp_cd"], "sBizAreaCd": codes.get("biz_area_cd", ""), "sBrchCd": codes.get("brch_cd", ""),
        "sProdType": "", "sItemCd": "", "sItemNm": "", "sStrgeCd": "", "sCrtQtyYn": True,
    }
    rows = pb.fetch_rows(frame, "/parts/inventory/selectInventoryList.do", body)
    pw = [r for r in rows if r.get("strgNm") == "부품창고"]
    if not pw:   # 조회가 잘못돼 0건이면 기존 RR 현재고를 지우지 않음
        raise RuntimeError(f"RR 부품창고 현재고가 0건입니다 (전체 {len(rows)}건, 코드 {codes}) — 지우지 않고 그대로 둠")
    rows_up, _changed = _upload_parts("inv_rr_parts", "rr_sent", branch, pw, now)
    return len(rows_up)


# ------------------------------------------------------------
# 대기 중: 앱 요청 처리
# ------------------------------------------------------------

def poll(page) -> None:
    t = time.time()
    if t - _S.last_poll < POLL_EVERY_SEC or not CONFIG.exists():
        return
    _S.last_poll = t
    try:
        if not _ensure_token():
            return
        branch = _cfg()["branch"]
        if t - _S.last_beat >= HEARTBEAT_EVERY_SEC:
            _rest("PATCH", f"inv_status?branch=eq.{_q(branch)}", {"daemon_seen_at": _now_iso()})
            _S.last_beat = t
        # 데몬이 멈춘 동안 쌓인 요청은 버림 (늦게 실행된 위치 변경이 DMS를 바꾸지 않게)
        cutoff = _q(datetime.fromtimestamp(t - REQ_EXPIRE_SEC, timezone.utc).isoformat())
        _rest("PATCH", f"inv_requests?branch=eq.{_q(branch)}&status=eq.pending&requested_at=lt.{cutoff}",
              {"status": "cancelled", "error": "오래된 요청이라 처리하지 않았습니다", "finished_at": _now_iso()})
        reqs = _rest("GET", f"inv_requests?branch=eq.{_q(branch)}&status=eq.pending&order=requested_at.asc&limit=1"
                            "&select=id,kind,item_cd,params,requested_by_name", prefer="")
        if reqs:
            _handle(page, branch, reqs[0])
    except Exception as e:
        _log(f"요청 확인 실패: {type(e).__name__}: {e}")


def _finish(req_id: int, status: str, result=None, error=None) -> None:
    _rest("PATCH", f"inv_requests?id=eq.{req_id}",
          {"status": status, "result": result, "error": error, "finished_at": _now_iso()})


def _handle(page, branch: str, req: dict) -> None:
    # 다른 처리기가 먼저 가져가지 않도록 pending → running 으로 바꾼 경우에만 처리
    # 앱이 그 사이 취소했으면 status 가 바뀌어 있어 가져오지 않음
    taken = _rest("PATCH", f"inv_requests?id=eq.{req['id']}&status=eq.pending",
                  {"status": "running", "started_at": _now_iso()}, "return=representation")
    if not taken:
        return
    kind, pn = req["kind"], (req.get("item_cd") or "").strip().upper()
    try:
        if not re.fullmatch(r"[A-Z0-9]{5,20}", pn) or pn.startswith("Z"):
            raise ValueError(f"품번 형식이 아닙니다: {pn}")
        if kind in ("rdc", "stock"):
            result = _lookup(page, branch, pn, update_part=(kind == "stock"))
        elif kind == "loc_change":
            result = _loc_change(page, branch, pn, req.get("params") or {}, req.get("requested_by_name"))
        else:
            raise ValueError(f"알 수 없는 요청: {kind}")
        _finish(req["id"], "done", result=result)
    except Exception as e:
        _log(f"요청 #{req['id']} {kind} {pn} 실패: {e}")
        _finish(req["id"], "failed", error=str(e)[:500])


def _lookup(page, branch: str, pn: str, update_part: bool) -> dict:
    import __main__ as pb   # partsbay.py 의 DMS 함수 사용
    raw = pb.lookup_stock(page, pn)
    own_rows = [r for r in (raw.get("own") or []) if r.get("strgNm") == "부품창고" and r.get("itemCd") == pn]
    own = own_rows[0] if own_rows else None
    rdc_rows = ((raw.get("rdc") or {}).get("data") or [])
    rdc_qty = sum(_num(r.get("crtQty")) for r in rdc_rows if r.get("itemCd") == pn)
    result = {
        "found": own is not None,
        "crt_qty": _num(own.get("crtQty")) if own else 0,
        "able_qty": _num(own.get("ableQty")) if own else 0,
        "lct_cd": ((own.get("lctCd") or "").strip() if own else "") or None,
        "item_nm": own.get("itemNm") if own else None,
        "rdc_qty": rdc_qty,
        "rdc_error": raw.get("rdc_error") or raw.get("own_error"),
        "checked_at": _now_iso(),
    }
    if update_part and own:
        row = _part_row(branch, own)
        _rest("POST", "inv_parts?on_conflict=branch,item_cd", [dict(row, updated_at=_now_iso())],
              "resolution=merge-duplicates,return=minimal")
        _S.parts_sent[pn] = row
    return result


# ---- 위치 변경: 재고마스터 화면에서 사람이 하는 순서 그대로 (조회 → 줄 선택 → 로케이션코드만 수정 → 저장) ----

_SELECT_JS = """
async (pn) => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const grid = $("#itemGrid").data("kendoExtGrid");
  grid.dataSource.data([]);
  $("#sItemCd").val(pn);
  document.getElementById("btnSearch").click();
  let rows = [];
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    rows = grid.dataSource.data().filter(x => x.itemCd === pn);
    if (rows.length) break;
  }
  if (rows.length !== 1) return {ok: false, reason: "재고마스터 조회 결과 " + rows.length + "건"};
  const tr = grid.tbody.find("tr[data-uid='" + rows[0].uid + "']");
  grid.select(tr);
  grid.trigger("change");
  for (let i = 0; i < 40 && $("#itemCd").val() !== pn; i++) await sleep(250);
  if ($("#itemCd").val() !== pn) return {ok: false, reason: "입력칸이 채워지지 않음"};
  await sleep(800);
  return {ok: true, item: JSON.parse(JSON.stringify(rows[0].toJSON()))};
}
"""

_SAVE_JS = """
async ({pn, loc, dealer, brch}) => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  if ($("#itemCd").val() !== pn) return {ok: false, saved: false, reason: "선택된 부품이 다름"};
  const before = JSON.parse(JSON.stringify(masterData()));
  if (String(before.dlrCd) !== dealer || String(before.brchCd) !== brch)
    return {ok: false, saved: false, reason: "우리 지점 부품이 아님"};
  if (before.stockBlMtItemYn === "N") return {ok: false, saved: false, reason: "재고균형유지품목여부가 '아니오'인 부품이라 DMS에서 직접 바꿔야 합니다"};
  if ($("#orgPurcEmQty").val() != $("#purcEmQty").val()) return {ok: false, saved: false, reason: "구매요소수량이 원래 값과 달라 저장하지 않음"};
  $("#lctCd").val(loc);
  const after = JSON.parse(JSON.stringify(masterData()));
  const diffs = Object.keys(after).filter(k => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
  if (diffs.length !== 1 || diffs[0] !== "lctCd") {
    $("#lctCd").val(before.lctCd);
    return {ok: false, saved: false, reason: "위치 말고 바뀌는 값이 있어 저장하지 않음: " + diffs.join(",")};
  }
  window.__locSave = null;
  if (!window.__locSaveHooked) {
    $(document).ajaxComplete(function (e, xhr, s) {
      if ((s.url || "").indexOf("updateItemStockMaster") >= 0)
        window.__locSave = {status: xhr.status, text: (xhr.responseText || "").slice(0, 300)};
    });
    window.__locSaveHooked = true;
  }
  document.getElementById("btnSave1").click();
  for (let i = 0; i < 80 && !window.__locSave; i++) await sleep(250);
  const dialog = [...document.querySelectorAll(".k-window")].some(w => w.offsetParent !== null);
  return {ok: !!window.__locSave && window.__locSave.status === 200, saved: !!window.__locSave,
          save: window.__locSave, dialogVisible: dialog};
}
"""

_VOLATILE = ("updt", "Updt", "regDt", "RegDt", "uid", "dirty")
_SCREEN_CLEARS = ("preSplyCd", "sftyStockPrid")


def _other_changes(a: dict, b: dict) -> dict:
    out = {}
    for k in sorted(set(a) | set(b)):
        if k == "lctCd" or any(v in k for v in _VOLATILE):
            continue
        if json.dumps(a.get(k), ensure_ascii=False) != json.dumps(b.get(k), ensure_ascii=False):
            out[k] = [a.get(k), b.get(k)]
    return out


def _stock_master_frame(page):
    page.evaluate("""() => {
        const a = [...document.querySelectorAll('a[data-url]')].find(x => x.textContent.trim() === '재고마스터');
        if (!a) throw new Error('재고마스터 메뉴를 찾지 못했습니다');
        a.click();
    }""")
    deadline = time.time() + 20
    while time.time() < deadline:
        for f in page.frames:
            if "selectItemStockMaster" in f.url:
                page.wait_for_timeout(1000)
                return f
        page.wait_for_timeout(300)
    raise RuntimeError("재고마스터 화면을 찾지 못했습니다")


def _loc_change(page, branch: str, pn: str, params: dict, who) -> dict:
    if LOC_HALT.exists():
        raise RuntimeError("위치 변경이 일시 중지된 상태입니다 (관리자 확인 필요)")
    to = str(params.get("to") or "").strip().upper()
    to = re.sub(r"^(\d+)\s*F\s*FLOOR$", r"\1F FLOOR", to)
    if not LOC_RE.fullmatch(to):
        raise ValueError(f"위치 형식이 아닙니다: {to}")
    c = _cfg()
    frame = _stock_master_frame(page)
    r0 = frame.evaluate(_SELECT_JS, pn)
    if not r0.get("ok"):
        raise RuntimeError(r0.get("reason"))
    cur = (r0["item"].get("lctCd") or "").strip()
    expected_from = params.get("from")
    if expected_from is not None and cur != (expected_from or "").strip():
        raise RuntimeError(f"그 사이 DMS 위치가 바뀌었습니다 (현재 {cur or '공란'}). 다시 조회 후 시도하세요")
    if cur == to:
        return {"from": cur, "to": to, "unchanged": True}
    s = frame.evaluate(_SAVE_JS, {"pn": pn, "loc": to, "dealer": c["dealer_cd"], "brch": c["brch_cd"]})
    if not s.get("ok"):
        if s.get("saved") or s.get("dialogVisible"):
            LOC_HALT.write_text(f"{_now_iso()} {pn} 저장 응답 이상: {s}\n", encoding="utf-8")
        raise RuntimeError(s.get("reason") or f"DMS 저장 실패: {s.get('save')}")
    page.wait_for_timeout(1500)
    r1 = frame.evaluate(_SELECT_JS, pn)
    got = ((r1.get("item") or {}).get("lctCd") or "").strip()
    other = _other_changes(r0["item"], r1.get("item") or {})
    # 재고마스터 화면 저장이 원래 비우는 값 (직원이 화면에서 직접 저장해도 같음, 사용자 승인 2026-10-07)
    #   preSplyCd(이전보급코드): 공백 → 빈값 / sftyStockPrid(안전재고기간): 화면 저장 데이터에 없는 항목이라 빈값이 됨
    allowed = {k: v for k, v in other.items() if k in _SCREEN_CLEARS and v[1] in (None, "")}
    other = {k: v for k, v in other.items() if k not in allowed}
    if not r1.get("ok") or got != to or other:
        LOC_HALT.write_text(f"{_now_iso()} {pn} 저장 후 확인 이상: 위치={got} 다른 변경={other}\n", encoding="utf-8")
        raise RuntimeError(f"저장 후 확인 이상 (위치 {got}, 다른 변경 {list(other)}) — 위치 변경을 멈췄습니다")
    # 앱 화면에도 바로 반영
    _rest("PATCH", f"inv_parts?branch=eq.{_q(branch)}&item_cd=eq.{_q(pn)}", {"lct_cd": to, "updated_at": _now_iso()})
    if pn in _S.parts_sent:
        _S.parts_sent[pn] = dict(_S.parts_sent[pn], lct_cd=to)
    _log(f"위치 변경 {pn}: {cur or '공란'} → {to} ({who})" + (f" / 화면 저장으로 비워진 값 {allowed}" if allowed else ""))
    return {"from": cur, "to": to}
