/* DS재고 관리 — 해운대 부품창고 휴대폰 바코드 재고 관리 앱
 *
 * 데이터 흐름
 *   파츠베이 데몬(이 PC) ──10분마다──▶ Supabase inv_parts / inv_audit_source / inv_status
 *   앱 ──요청──▶ inv_requests ──3초마다──▶ 데몬이 DMS에서 처리 (RDC 조회, 현재고 조회, 위치 변경)
 *   앱 ──▶ inv_checks (수량 다름), inv_audits / inv_audit_items (재고조사)
 * 로그인은 태블릿 입출고 앱과 같은 계정 (아이디 → 아이디@tablet.dongsung.local)
 */
(function () {
  "use strict";

  var SUPABASE_URL = "https://qswzxudtzjuheugdnuoc.supabase.co";
  var SUPABASE_KEY = "sb_publishable_L2_ucSAJjdWvMfvWZborbQ_1cmSAuR4";
  var LOGIN_DOMAIN = "@tablet.dongsung.local";
  var SCAN_COOLDOWN_MS = 3000;        // 같은 바코드는 3초 동안 다시 읽지 않음
  var STATUS_POLL_MS = 60000;         // 데몬 상태·재고 갱신 확인 주기
  var DAEMON_STALE_MS = 3 * 60000;    // 데몬 응답이 이보다 오래되면 경고
  var REQ_POLL_MS = 700;              // 요청 처리 결과 확인 주기
  var REQ_GIVEUP_MS = 10 * 60000;     // 이만큼 기다려도 데몬이 안 가져가면 요청 취소 (데몬도 10분 지난 요청은 버림)
  var APP_VER = ((document.currentScript && document.currentScript.src || "").match(/[?&]v=(\d+)/) || [])[1];
  var GROUPS ={ A: "상시재고", L: "로컬조달", O: "특수/단종계열", I: "비이동성", S: "특수발주" };

  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "inventory-scan-auth" }
  });

  // 이 휴대폰에만 남기는 설정 (최근 스캔, 카메라·소리 설정)
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem("inv." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem("inv." + k, JSON.stringify(v)); } catch (e) { /* 저장 못 해도 동작 */ } }
  };

  var state = {
    user: null,            // {id, name, login_id, role, branch}
    tab: "scan",
    result: [],            // 스캔 화면 아래 결과 이동 기록 (위치 → 부품)
    mode: store.get("scanMode", "bt"),   // 블루투스 스캐너 우선 (카메라는 인식률 개선 전까지 보조)
    sort: "pn",
    locQ: null,            // 위치 화면 검색어 {loc, q} (화면을 다시 그려도 유지)
    parts: {},             // item_cd -> 현재고 행
    locs: {},              // lct_cd -> [item_cd]
    status: null,          // inv_status
    rdc: {},               // item_cd -> {status, result, error, at}
    rrParts: {},           // item_cd -> RR DMS 부품창고 현재고 행 (RR 데몬이 10분마다 올림)
    moves: {},             // item_cd -> {from, to, status, error, time, reqId}
    checks: [],            // 지우지 않은 체크 기록
    recent: store.get("recent", []),
    sources: {},           // kind -> inv_audit_source
    audits: {},            // kind -> 최근 inv_audits
    auditOpen: null,       // 열려 있는 조사 kind
    auditItems: [],        // 열려 있는 조사의 항목
    auditFilter: "left",
    auditLoc: null,
    moveLog: null,         // 위치 변경 이력 {rows} | {error}
    moveQ: "",             // 이력 검색어
    moveFilter: "all",     // all | done | problem
    movesBack: "settings", // 이력 화면에서 돌아갈 곳 (settings | scan)
    loading: true
  };

  // ---------- 유틸 ----------
  var $ =function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function hhmm(d) { d = d ? new Date(d) : new Date(); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
  function qtyNum(v) { var n = Number(v); return Number.isInteger(n) ? n : Math.round(n * 100) / 100; }
  function normCode(raw) {
    var c = String(raw || "").trim().toUpperCase().replace(/\s+/g, " ");
    var f = c.match(/^(\d+)\s*F\s*FLOOR$/);
    if (f) return f[1] + "F FLOOR";
    return c.replace(/\s+/g, "");
  }
  // DMS LOCATION 형식: 영문 1 + 숫자 6 (A140112), 층 단위 위치 (4F FLOOR)
  function looksLoc(code) { return /^[A-Z]\d{6}$/.test(code) || /^\d+F FLOOR$/.test(code); }
  function isLoc(code) { return looksLoc(code) && !!state.locs[code]; }
  function partsAt(loc) { return (state.locs[loc] || []).map(function (k) { return state.parts[k]; }); }
  function basis() { return state.status && state.status.parts_at ? hhmm(state.status.parts_at) : "--:--"; }
  function daemonStale() {
    if (!state.status || !state.status.daemon_seen_at) return true;
    return Date.now() - new Date(state.status.daemon_seen_at).getTime() > DAEMON_STALE_MS;
  }
  // RR 현재고 문제: 데몬이 RR 을 못 올렸으면 그 이유, 25분 넘게 안 올라왔으면 오래됨
  var RR_STALE_MS = 25 * 60000;
  function rrProblem() {
    var s = state.status || {};
    if (s.rr_error) return s.rr_error;
    if (s.rr_parts_at && Date.now() - new Date(s.rr_parts_at).getTime() > RR_STALE_MS) return "RR 현재고가 오래됨";
    return "";
  }
  var CHEV = '<svg class="chev" viewBox="0 0 8 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 1.5l5 5-5 5"/></svg>';
  var BACK = '<svg viewBox="0 0 12 20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2L2 10l8 8"/></svg>';
  var CLOSE = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 2l8 8M10 2l-8 8"/></svg>';
  var REFRESH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>';
  var SEARCH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5"/></svg>';

  var toastTimer;
  // 화면 위쪽 작은 알림. 결과가 화면에 바로 보이는 동작에는 띄우지 않고, 오류·안 보이는 결과만. 누르면 닫힘
  var TOAST_ERR = /실패|못했|없는|아닙니다|입력하세요|필요합니다|않습니다|눌러 주세요/;
  function toast(msg) {
    var err = TOAST_ERR.test(msg);
    $("toastText").textContent = msg;
    $("toast").classList.toggle("err", err);
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $("toast").hidden = true; }, err ? 3000 : 1600);
  }
  $("toast").addEventListener("click", function () { clearTimeout(toastTimer); $("toast").hidden = true; });

  // 스캔 성공 소리·진동
  var audioCtx = null;
  function beep() {
    if (!store.get("sound", true)) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 1760; g.gain.value = 0.08;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.08);
    } catch (e) { /* 소리 없이 진행 */ }
    if (navigator.vibrate) navigator.vibrate(40);
  }

  // ---------- 데이터 ----------
  // 현재고는 처음에 전부 받고, 그 뒤로는 데몬이 바꾼 행만 받음 (휴대폰 데이터 절약). 1시간마다는 전부 다시 받음
  var PARTS_FULL_MS = 60 * 60000;
  var partsSyncAt = null, partsFullAt = 0;   // 마지막으로 받은 행의 updated_at (서버 시각 그대로), 마지막 전체 받기
  async function fetchParts(since) {
    var all = [], from = 0, size = 1000;
    for (;;) {
      var q = sb.from("inv_parts").select("item_cd,item_nm,lct_cd,crt_qty,alois_cd,last_purc_dt,updated_at");
      if (since) q = q.gte("updated_at", since);
      var r = await q.order("item_cd").range(from, from + size - 1);
      if (r.error) throw r.error;
      all = all.concat(r.data);
      if (r.data.length < size) break;
      from += size;
    }
    all.forEach(function (p) { if (!partsSyncAt || Date.parse(p.updated_at) > Date.parse(partsSyncAt)) partsSyncAt = p.updated_at; });
    return all;
  }
  function locRemove(loc, pn) {
    if (!loc || !state.locs[loc]) return;
    state.locs[loc] = state.locs[loc].filter(function (k) { return k !== pn; });
    if (!state.locs[loc].length) delete state.locs[loc];
  }
  function locAdd(loc, pn) { if (loc) (state.locs[loc] = state.locs[loc] || []).push(pn); }
  async function loadParts() {
    partsSyncAt = null;
    var all = await fetchParts(null);
    var parts = {}, locs = {};
    all.forEach(function (p) {
      parts[p.item_cd] = p;
      if (p.lct_cd) (locs[p.lct_cd] = locs[p.lct_cd] || []).push(p.item_cd);
    });
    state.parts = parts; state.locs = locs;
    partsFullAt = Date.now();
  }
  // RR DMS 부품창고 현재고 (RR 데몬이 10분마다 올림)
  var lastRrAt = null;
  async function loadRrParts() {
    var all = [], from = 0, size = 1000;
    for (;;) {
      var r = await sb.from("inv_rr_parts").select("item_cd,item_nm,lct_cd,crt_qty").order("item_cd").range(from, from + size - 1);
      if (r.error) throw r.error;
      all = all.concat(r.data);
      if (r.data.length < size) break;
      from += size;
    }
    var m = {};
    all.forEach(function (p) { m[p.item_cd] = p; });
    state.rrParts = m;
  }
  async function updateParts() {
    if (!partsSyncAt || Date.now() - partsFullAt > PARTS_FULL_MS) return loadParts();
    var rows = await fetchParts(partsSyncAt);
    rows.forEach(function (p) {
      var old = state.parts[p.item_cd];
      if (!old || old.lct_cd !== p.lct_cd) { if (old) locRemove(old.lct_cd, p.item_cd); locAdd(p.lct_cd, p.item_cd); }
      state.parts[p.item_cd] = p;
    });
    // 없어진 품번은 바뀐 행으로 알 수 없으니, 개수가 다르면 전부 다시 받음
    var c = await sb.from("inv_parts").select("item_cd", { count: "exact", head: true });
    if (!c.error && c.count !== Object.keys(state.parts).length) await loadParts();
  }
  async function loadStatus() {
    var r = await sb.from("inv_status").select("*").maybeSingle();
    if (!r.error) state.status = r.data;
  }
  async function loadChecks() {
    var all = [], from = 0, size = 1000;
    for (;;) {
      var r = await sb.from("inv_checks").select("*").is("cleared_at", null).order("checked_at", { ascending: false }).order("id").range(from, from + size - 1);
      if (r.error) return;
      all = all.concat(r.data);
      if (r.data.length < size) break;
      from += size;
    }
    state.checks = all;
  }
  async function loadAudits() {
    var src = await sb.from("inv_audit_source").select("kind,period_start,period_end,items,updated_at");
    if (!src.error) { state.sources = {}; src.data.forEach(function (s) { state.sources[s.kind] = s; }); }
    var au = await sb.from("inv_audits").select("*").order("started_at", { ascending: false }).limit(20);
    if (!au.error) {
      state.audits = {};
      au.data.forEach(function (a) { if (!state.audits[a.kind]) state.audits[a.kind] = a; });
    }
  }
  async function loadAuditItems(auditId) {
    var all = [], from = 0, size = 1000;
    for (;;) {
      var r = await sb.from("inv_audit_items").select("*").eq("audit_id", auditId).range(from, from + size - 1);
      if (r.error) throw r.error;
      all = all.concat(r.data);
      if (r.data.length < size) break;
      from += size;
    }
    all.sort(function (a, b) { return (a.lct_cd || "~").localeCompare(b.lct_cd || "~") || a.item_cd.localeCompare(b.item_cd); });
    state.auditItems = all;
    applyOutbox(auditId);
  }

  var lastPartsAt = null;
  async function refreshStatus() {
    await loadStatus();
    var at = state.status && state.status.parts_at;
    if (at && at !== lastPartsAt) {   // 데몬이 새로 올렸으면 현재고 다시 받기
      lastPartsAt = at;
      try { await updateParts(); } catch (e) { /* 다음 확인 때 다시 */ }
      await loadAudits();
    }
    var rrAt = state.status && state.status.rr_parts_at;
    if (rrAt && rrAt !== lastRrAt) {
      try { await loadRrParts(); lastRrAt = rrAt; } catch (e) { /* 다음 확인 때 다시 */ }
    }
    flushOutbox();
    if (state.tab === "moves") await loadMoveLog();
    render(false);
  }

  // ---------- 데몬 요청 ----------
  // 데몬이 멈췄으면 요청을 쌓지 않음 (나중에 한꺼번에 처리되지 않게). 상태가 오래됐을 수 있어 한 번 다시 확인
  async function daemonReady() {
    if (!daemonStale()) return true;
    await loadStatus();
    return !daemonStale();
  }
  async function sendRequest(kind, pn, params) {
    if (!(await daemonReady())) throw new Error("DMS 연결 PC가 응답하지 않습니다");
    var r = await sb.from("inv_requests").insert({ kind: kind, item_cd: pn, params: params || {} }).select("id").single();
    if (r.error) throw r.error;
    return r.data.id;
  }
  function waitRequest(id, onDone) {
    var since = Date.now();
    (function tick() {
      sb.from("inv_requests").select("status,result,error").eq("id", id).single().then(async function (r) {
        var st = !r.error && r.data.status;
        if (st === "done" || st === "failed") { onDone(r.data); return; }
        if (st === "cancelled") { onDone({ status: "failed", error: r.data.error || "취소된 요청입니다" }); return; }
        var waited = Date.now() - since;
        // 오래 기다렸는데 아직 대기 중이면 취소 (데몬이 이미 가져가 처리 중이면 취소되지 않으니 결과를 더 기다림)
        if (st === "pending" && waited > REQ_GIVEUP_MS) {
          var c = await sb.rpc("inv_cancel_request", { p_id: id });
          if (!c.error && c.data) { onDone({ status: "failed", error: "응답이 없어 취소했습니다 (DMS 연결 PC 확인 필요)" }); return; }
        }
        if (waited > 2 * REQ_GIVEUP_MS) {
          onDone({ status: "failed", error: "처리 결과를 확인하지 못했습니다" }); return;
        }
        setTimeout(tick, REQ_POLL_MS);
      });
    })();
  }

  function requestRdc(pn) {
    var cur = state.rdc[pn];
    if (cur && (cur.status === "pending" || (cur.status === "done" && Date.now() - cur.at < 5 * 60000))) return;
    state.rdc[pn] = { status: "pending", at: Date.now() };
    sendRequest("rdc", pn).then(function (id) {
      waitRequest(id, function (res) {
        state.rdc[pn] = { status: res.status, result: res.result, error: res.error, at: Date.now() };
        if ($("rdcTile") && $("rdcTile").getAttribute("data-pn") === pn) $("rdcTile").innerHTML = rdcTile(pn);
      });
    }).catch(function (e) {
      state.rdc[pn] = { status: "failed", error: e.message, at: Date.now() };
      if ($("rdcTile")) $("rdcTile").innerHTML = rdcTile(pn);
    });
  }

  // ---------- 스캔 처리 (카메라·블루투스·직접 입력 공통) ----------
  var lastScan = { code: "", at: 0 };
  function resolve(raw, fromScanner, fromCamera) {
    var code = normCode(raw);
    if (!code) return;
    if (fromScanner && !fromCamera) {
      var t = Date.now();
      if (code === lastScan.code && t - lastScan.at < SCAN_COOLDOWN_MS) return;
      lastScan = { code: code, at: t };
    }
    if (/^Z/.test(code)) { toast("Z로 시작하는 서비스 코드는 조회하지 않습니다"); return; }

    var via = fromCamera ? "camera" : fromScanner ? "scanner" : null;   // 손으로 친 것(null)은 현장 확인으로 안 침
    // 재고 확인 창이 잠겨 있으면: 그 위치·부품을 찍으면 열림
    if (via && !$("sheet").hidden && $("aLock")) { beep(); auditSheetScan(code, via); return; }
    // 위치 변경 창이 열려 있으면 스캔한 위치를 새 위치 칸에 넣음
    if (!$("sheet").hidden) {
      if ($("newLoc") && looksLoc(code)) { $("newLoc").value = code; $("newLoc").dispatchEvent(new Event("input", { bubbles: true })); beep(); }
      return;
    }
    if (fromScanner) beep();
    if ($("manualInput")) $("manualInput").value = "";

    if ($("reportView")) return;   // 보고서 미리보기 중
    if (state.tab === "audit" && state.auditOpen && currentAudit()) { auditScan(code, via); return; }

    var type = isLoc(code) ? "loc" : state.parts[code] ? "part" : null;
    if (!type) {
      if (/^[A-Z0-9]{5,20}$/.test(code) && !looksLoc(code)) { openUnknownPart(code); return; }
      toast(looksLoc(code) ? "이 위치에 있는 부품이 없습니다: " + code : "등록된 부품이나 위치가 아닙니다: " + code);
      return;
    }
    pushRecent(code);
    state.tab = "scan";
    state.locQ = null;
    state.result = [{ type: type, code: code }];
    render(true);
  }
  function pushRecent(code) {
    state.recent = [{ code: code, time: hhmm() }].concat(state.recent.filter(function (r) { return r.code !== code; })).slice(0, 50);
    store.set("recent", state.recent);
  }

  // ---------- 검색칸 부분 일치 ----------
  // 품번 일부(앞 11718, 뒤 6980 등)나 위치 일부를 치면 맞는 부품·위치를 바로 아래에 보여 줌. 누르면 조회
  // 재고조사 중에는 그 조사 목록 안에서만 찾음
  var SUGGEST_MIN = 3, SUGGEST_MAX = 50;
  function inAudit() { return state.tab === "audit" && state.auditOpen && !!currentAudit(); }
  function exactCode(c) { return inAudit() ? !!findAuditItem(c) || state.auditItems.some(function (x) { return x.lct_cd === c; }) : isLoc(c) || !!state.parts[c]; }
  function suggestItems(q) {
    q = String(q || "").replace(/\s+/g, "");
    if (q.length < SUGGEST_MIN) return [];
    var out = [];
    function add(code, o) { var i = code.replace(/\s+/g, "").indexOf(q); if (i >= 0) { o.code = code; o.at = i; out.push(o); } }
    if (inAudit()) {
      state.auditItems.forEach(function (it) { add(it.item_cd, { nm: it.item_nm, loc: it.lct_cd, qty: itemTotal(it), done: !!it.status }); });
    } else {
      Object.keys(state.locs).forEach(function (l) { add(l, { isLoc: true, n: state.locs[l].length }); });
      Object.keys(state.parts).forEach(function (k) { var pp = state.parts[k]; add(k, { nm: pp.item_nm, loc: pp.lct_cd, qty: Number(pp.crt_qty) + rrQty(k) }); });
    }
    out.sort(function (a, b) { return (a.at === 0 ? 0 : 1) - (b.at === 0 ? 0 : 1) || (a.isLoc ? 0 : 1) - (b.isLoc ? 0 : 1) || a.code.localeCompare(b.code); });
    return out;
  }
  function markHit(code, q) {
    var i = code.indexOf(q);
    return i < 0 ? esc(code) : esc(code.slice(0, i)) + '<mark>' + esc(code.slice(i, i + q.length)) + '</mark>' + esc(code.slice(i + q.length));
  }
  function hideSuggest() { var b = $("suggest"); if (b) { b.hidden = true; b.innerHTML = ""; } }
  function renderSuggest() {
    var box = $("suggest"), inp = $("manualInput");
    if (!box || !inp) return;
    var q = normCode(inp.value).replace(/\s+/g, ""), list = suggestItems(q);
    if (q.length < SUGGEST_MIN) { hideSuggest(); return; }
    var rows = list.slice(0, SUGGEST_MAX).map(function (x) {
      if (x.isLoc) return '<button class="sug" data-sug="' + esc(x.code) + '"><span class="tag loc">위치</span><div class="sug-main"><div class="sug-code mono-loc">' + markHit(x.code, q) + '</div><div class="sug-sub">부품 ' + x.n + '종</div></div></button>';
      return '<button class="sug' + (x.done ? ' done' : '') + '" data-sug="' + esc(x.code) + '"><div class="sug-main"><div class="sug-code pn">' + markHit(x.code, q) + '</div>' +
        '<div class="sug-sub">' + esc(x.nm || "") + (x.loc ? ' · ' + esc(x.loc) : '') + (x.done ? ' · 확인함' : '') + '</div></div><span class="sug-qty">' + qtyNum(x.qty) + '<small>EA</small></span></button>';
    }).join("");
    box.innerHTML = list.length
      ? '<div class="sug-head">' + (inAudit() ? '조사 목록에서 ' : '') + list.length + '건' + (list.length > SUGGEST_MAX ? ' · 앞 ' + SUGGEST_MAX + '건만 표시, 더 입력하세요' : '') + '</div>' + rows
      : '<div class="sug-head">' + (inAudit() ? '조사 목록에 ' : '') + '"' + esc(q) + '"가 들어간 품번·위치가 없습니다</div>';
    box.hidden = false;
  }
  // 목록 밖을 누르면 닫음 (입력한 글자는 그대로)
  document.addEventListener("click", function (e) {
    var b = $("suggest");
    if (b && !b.hidden && !e.target.closest("#suggest") && !e.target.closest("#manual")) hideSuggest();
  }, true);

  // 블루투스 스캐너는 키보드처럼 입력된 뒤 Enter
  var buf = "", bufTimer;
  document.addEventListener("keydown", function (e) {
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
      if (t.getClientRects().length) return;   // 화면에 보이는 입력칸에 입력 중
      t.blur();                                 // 닫힌 창의 입력칸에 커서가 남아 있으면 스캐너 입력을 가로챔
    }
    // 스캐너 끝의 Enter 가 마지막으로 누른 버튼(예: 스캔 탭)을 다시 누르면 결과가 지워지므로 기본 동작을 막음
    if (e.key === "Enter") { e.preventDefault(); if (buf.length >= 5) resolve(buf, true); buf = ""; return; }
    if (e.key.length === 1 && /[0-9A-Za-z\- ]/.test(e.key)) {
      if (e.key === " ") e.preventDefault();
      buf += e.key;
      clearTimeout(bufTimer);
      bufTimer = setTimeout(function () { buf = ""; }, 300);
    }
  });

  // ---------- 카메라 ----------
  // 실시간 스캔: 안드로이드 크롬은 휴대폰 내장 인식기(BarcodeDetector), 아이폰 등은 zxing-cpp(WebAssembly).
  //   화면에 보이는 영역 가운데를 넓게 잘라 읽고, 같은 값이 연속으로 읽혀야 확정 (Code 39 는 검사 숫자가 없어 한 번 읽힌 값은 틀릴 수 있음)
  // 사진 스캔: 휴대폰 기본 카메라로 찍은 고해상도 사진을 zxing-cpp 로 꼼꼼히 분석 (초점·화질 문제를 피하는 확실한 방법)
  // 진단: 설정에서 켜면 그 순간의 카메라 장면을 inv_scan_diag 에 저장 → PC에서 실제 장면으로 인식 문제를 분석
  var ZXING_URL = "https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.5/reader/+esm";
  var NATIVE_FORMATS = ["code_39", "code_128", "code_93"];
  var ZX_FORMATS = ["Code39", "Code128", "Code93"];
  var SCAN_MAX_W = 1440;
  var FREEZE_MS = 700;
  var ZOOMS = [1, 1.5, 2];
  var cam = { stream: null, timer: null, starting: false, error: null, torchOk: false, torchOn: false, engine: "",
              caps: {}, zooms: [], zoom: 1, frozenUntil: 0, last: null, lastFound: [] };
  var zxPromise = null, enginePromise = null;

  function loadZxing() {
    if (!zxPromise) { zxPromise = import(ZXING_URL); zxPromise.catch(function () { zxPromise = null; }); }
    return zxPromise;
  }
  function zxFormat(f) { return String(f || "").replace("Code", "code_").toLowerCase(); }

  // 실시간 인식 엔진: detect(canvas) → [{code, format, pts}]
  function getEngine() {
    if (enginePromise) return enginePromise;
    enginePromise = (async function () {
      if ("BarcodeDetector" in window) {
        try {
          var sup = await window.BarcodeDetector.getSupportedFormats();
          var fmts = NATIVE_FORMATS.filter(function (f) { return sup.indexOf(f) >= 0; });
          if (fmts.length) {
            var d = new window.BarcodeDetector({ formats: fmts });
            return { name: "내장", detect: function (cv) {
              return d.detect(cv).then(function (r) { return r.map(function (x) { return { code: x.rawValue, format: x.format, pts: x.cornerPoints || [] }; }); });
            } };
          }
        } catch (e) { /* zxing-cpp 로 */ }
      }
      var zx = await loadZxing();
      return { name: "zxing-cpp", detect: function (cv) {
        var img = cv.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height);
        return zx.readBarcodes(img, { formats: ZX_FORMATS, tryHarder: true, tryRotate: false, tryInvert: false, tryDownscale: true, maxNumberOfSymbols: 3 })
          .then(function (r) {
            return r.filter(function (x) { return x.isValid; }).map(function (x) {
              var p = x.position;
              return { code: x.text, format: zxFormat(x.format), pts: p ? [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft] : [] };
            });
          });
      } };
    })();
    enginePromise.catch(function () { enginePromise = null; });
    return enginePromise;
  }

  function cameraWanted() {
    var host = $("scannerHost");
    return state.user && state.mode === "camera" && store.get("camera", true) && host && !host.hidden && document.visibilityState === "visible";
  }

  // 화면(object-fit: cover) ↔ 카메라 그림 좌표
  function viewMap(video) {
    var box = video.parentElement.getBoundingClientRect(), vw = video.videoWidth, vh = video.videoHeight;
    var s = Math.max(box.width / vw, box.height / vh);
    return { s: s, ox: (box.width - vw * s) / 2, oy: (box.height - vh * s) / 2, box: box };
  }
  // 읽을 영역: 화면에 보이는 부분의 가로 전체 × 가운데 60% (안내 칸 주변)
  function scanRect(video) {
    var m = viewMap(video), vw = video.videoWidth, vh = video.videoHeight;
    var x0 = Math.max(0, -m.ox / m.s), x1 = Math.min(vw, (m.box.width - m.ox) / m.s);
    var y0 = Math.max(0, -m.oy / m.s), y1 = Math.min(vh, (m.box.height - m.oy) / m.s);
    var h = (y1 - y0) * 0.6, cy = (y0 + y1) / 2;
    return { x: x0, y: cy - h / 2, w: x1 - x0, h: h };
  }

  var IDLE_HINT = "바코드를 칸에 맞추세요 · 안 읽히면 사진 버튼";
  function caption(msg, ok) {
    var cap = document.querySelector(".vf-caption");
    if (!cap) return;
    cap.textContent = msg || IDLE_HINT;
    cap.classList.toggle("ok", !!ok);
  }

  // 같은 값이 연속으로 읽혀야 확정. 목록에 있는 품번·위치는 2번, 없는 값은 3번
  // 확정한 바코드는 화면에서 1초 이상 사라지고 3초가 지나야 다시 읽음
  var votes = { code: "", n: 0, at: 0 };
  var fired = { code: "", at: 0, seen: 0 };
  function knownCode(code) { return isLoc(code) || !!state.parts[code] || (state.auditOpen && !!findAuditItem(code)); }

  var cropCanvas = document.createElement("canvas");
  async function tick(video, eng) {
    if (!cam.stream) return;
    if (video.readyState >= 2 && video.videoWidth) {
      try {
        var r = scanRect(video), k = Math.min(1, SCAN_MAX_W / r.w);
        var cw = Math.max(1, Math.round(r.w * k)), ch = Math.max(1, Math.round(r.h * k));
        if (cropCanvas.width !== cw || cropCanvas.height !== ch) { cropCanvas.width = cw; cropCanvas.height = ch; }
        cropCanvas.getContext("2d", { willReadFrequently: true }).drawImage(video, r.x, r.y, r.w, r.h, 0, 0, cw, ch);
        var found = (await eng.detect(cropCanvas)).map(function (x) {
          return { code: normCode(x.code), format: x.format, pts: (x.pts || []).map(function (p) { return { x: r.x + p.x / k, y: r.y + p.y / k }; }) };
        }).filter(function (x) { return x.code && !/^Z/.test(x.code); });
        cam.lastFound = found.map(function (x) { return x.code + " " + x.format; });
        var now = Date.now();
        // 화면 가운데에 가장 가까운 바코드
        var cx = r.x + r.w / 2, cyy = r.y + r.h / 2;
        var dist = function (x) { if (!x.pts.length) return 1e12; var c = center(x.pts); return Math.pow(c.x - cx, 2) + Math.pow(c.y - cyy, 2); };
        found.sort(function (a, b) { return dist(a) - dist(b); });
        if (found.some(function (x) { return x.code === fired.code; })) fired.seen = now;
        var b = found[0];
        if (b && now > cam.frozenUntil) {
          var again = b.code === fired.code && (now - fired.seen < 1000 || now - fired.at < SCAN_COOLDOWN_MS);
          if (!again) {
            if (votes.code === b.code && now - votes.at < 1200) votes.n++; else votes = { code: b.code, n: 1, at: now };
            votes.at = now;
            var need = knownCode(b.code) ? 2 : 3;
            var blocked = !$("sheet").hidden && !$("newLoc") && !$("aLock");
            if (votes.n >= need && !blocked) {
              votes = { code: "", n: 0, at: 0 };
              fired = { code: b.code, at: now, seen: now };
              freeze(video, b);
              resolve(b.code, true, true);
            } else if (!blocked) {
              caption("인식 중: " + b.code);
            }
          }
        }
      } catch (e) { /* 한 장면 인식 실패는 무시 */ }
    }
    if (cam.stream) cam.timer = setTimeout(function () { tick(video, eng); }, 80);
  }
  function center(pts) {
    var x = 0, y = 0;
    pts.forEach(function (p) { x += p.x; y += p.y; });
    return { x: x / pts.length, y: y / pts.length };
  }

  // 찍힌 장면을 잠깐 멈춰 보여 줌: 읽은 바코드를 초록 테두리와 값으로 표시
  function freeze(video, hit) {
    var cv = $("camFreeze");
    var flash = document.querySelector(".vf-flash");
    if (flash) { flash.classList.add("go"); setTimeout(function () { flash.classList.remove("go"); }, 30); }
    cam.frozenUntil = Date.now() + FREEZE_MS;
    caption("인식: " + hit.code + (hit.format ? " (" + String(hit.format).replace("_", " ").toUpperCase() + ")" : ""), true);
    if (!cv) return;
    var m = viewMap(video), W = Math.round(m.box.width), H = Math.round(m.box.height);
    cv.width = W; cv.height = H;
    var ctx = cv.getContext("2d");
    ctx.drawImage(video, m.ox, m.oy, video.videoWidth * m.s, video.videoHeight * m.s);
    if (hit.pts.length) {
      var pts = hit.pts.map(function (p) { return { x: p.x * m.s + m.ox, y: p.y * m.s + m.oy }; });
      var xs = pts.map(function (p) { return p.x; }), ys = pts.map(function (p) { return p.y; });
      var x0 = Math.min.apply(null, xs) - 6, x1 = Math.max.apply(null, xs) + 6, y0 = Math.min.apply(null, ys) - 6, y1 = Math.max.apply(null, ys) + 6;
      if (y1 - y0 < 24) { var cy = (y0 + y1) / 2; y0 = cy - 12; y1 = cy + 12; }
      ctx.fillStyle = "rgba(48,209,88,.22)"; ctx.strokeStyle = "#30D158"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.fill(); ctx.stroke();
    }
    cv.hidden = false;
    setTimeout(function () { if ($("camFreeze")) $("camFreeze").hidden = true; }, FREEZE_MS);
  }

  function placeGuide(video) {
    var el = $("camGuide");
    if (!el || !video.videoWidth) return;
    var box = video.parentElement.getBoundingClientRect();
    var w = box.width * 0.78, h = Math.max(44, box.height * 0.26);
    el.style.left = (box.width - w) / 2 + "px"; el.style.top = (box.height - h) / 2 + "px";
    el.style.width = w + "px"; el.style.height = h + "px";
    el.hidden = false;
  }

  async function syncCamera() {
    if (!cameraWanted()) { stopCamera(); return; }
    if (cam.stream || cam.starting) return;
    var video = $("camVideo");
    if (!video) return;
    cam.starting = true; cam.error = null;
    try {
      var engP = getEngine();
      var stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 2560 }, height: { ideal: 1440 } }
      });
      cam.stream = stream;
      var track = stream.getVideoTracks()[0];
      var caps = {};
      try { caps = track.getCapabilities ? track.getCapabilities() : {}; } catch (e) { caps = {}; }
      cam.caps = caps;
      cam.torchOk = !!caps.torch;
      var zr = caps.zoom;
      cam.zooms = zr && zr.max > 1 ? ZOOMS.filter(function (z) { return z >= (zr.min || 1) && z <= zr.max; }) : [];
      if (cam.zooms.length < 2) cam.zooms = [];
      var saved = store.get("zoom", 1.5);
      cam.zoom = cam.zooms.indexOf(saved) >= 0 ? saved : 1;
      if (cam.zoom !== 1) await track.applyConstraints({ advanced: [{ zoom: cam.zoom }] }).catch(function () { cam.zoom = 1; });
      if (caps.focusMode && caps.focusMode.indexOf("continuous") >= 0) track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(function () {});
      video.srcObject = stream;
      await video.play();
      video.onresize = function () { placeGuide(video); };
      placeGuide(video);
      renderCamTools();
      var eng = await engP;
      cam.engine = eng.name + " · " + video.videoWidth + "×" + video.videoHeight;
      caption("");
      tick(video, eng);
    } catch (e) {
      stopCamera();
      cam.error = e && e.name === "NotAllowedError" ? "카메라 권한이 꺼져 있습니다. 브라우저 설정에서 허용해 주세요."
        : e && e.name === "NotReadableError" ? "다른 앱이 카메라를 쓰고 있습니다. 그 앱을 닫고 다시 시도하세요."
        : e && e.name === "NotFoundError" ? "카메라를 찾지 못했습니다." : "카메라를 켜지 못했습니다. (" + (e && (e.name || e.message) || "오류") + ")";
      renderScanner();
    }
    cam.starting = false;
    if (!cameraWanted()) stopCamera();
  }
  function stopCamera() {
    if (cam.timer) { clearTimeout(cam.timer); cam.timer = null; }
    if (cam.stream) { cam.stream.getTracks().forEach(function (t) { t.stop(); }); cam.stream = null; }
    cam.torchOn = false;
  }
  function renderCamTools() {
    var el = $("camTools");
    if (!el) return;
    el.innerHTML =
      '<button class="vf-tool photo" id="photoBtn" aria-label="사진으로 스캔">사진</button>' +
      (store.get("diag", false) ? '<button class="vf-tool" id="diagBtn">진단</button>' : '') +
      (cam.zooms.length ? '<div class="vf-zooms" role="group" aria-label="확대">' + cam.zooms.map(function (z) {
        return '<button class="vf-tool' + (z === cam.zoom ? " on" : "") + '" data-zoom="' + z + '">' + z + 'x</button>';
      }).join("") + '</div>' : '') +
      (cam.torchOk ? '<button class="vf-tool' + (cam.torchOn ? " on torch" : "") + '" id="torchBtn" aria-label="플래시">플래시</button>' : '');
  }
  function setZoom(z) {
    if (!cam.stream || z === cam.zoom) return;
    cam.stream.getVideoTracks()[0].applyConstraints({ advanced: [{ zoom: z }] }).then(function () {
      cam.zoom = z; store.set("zoom", z); renderCamTools();
    }).catch(function () { cam.zooms = []; renderCamTools(); });
  }
  function toggleTorch() {
    if (!cam.stream) return;
    cam.torchOn = !cam.torchOn;
    cam.stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: cam.torchOn }] }).catch(function () { cam.torchOn = false; });
    renderCamTools();
  }
  // 누른 자리에 초점 (안드로이드 크롬만 실제로 지정 가능, 아이폰은 브라우저가 막아 둠 → 사진 스캔 권장)
  function tapFocus(ev) {
    var video = $("camVideo");
    if (!cam.stream || !video || !video.videoWidth) return;
    var m = viewMap(video), x = ev.clientX - m.box.left, y = ev.clientY - m.box.top;
    var ring = document.createElement("span");
    ring.className = "focus-ring"; ring.style.left = x + "px"; ring.style.top = y + "px";
    video.parentElement.appendChild(ring);
    setTimeout(function () { ring.remove(); }, 900);
    var track = cam.stream.getVideoTracks()[0], fm = cam.caps.focusMode || [];
    var poi = [{ x: Math.min(1, Math.max(0, (x - m.ox) / m.s / video.videoWidth)), y: Math.min(1, Math.max(0, (y - m.oy) / m.s / video.videoHeight)) }];
    var mode = fm.indexOf("single-shot") >= 0 ? "single-shot" : fm.indexOf("continuous") >= 0 ? "continuous" : null;
    var c = {};
    if (cam.caps.pointsOfInterest !== undefined) c.pointsOfInterest = poi;
    if (mode) c.focusMode = mode;
    if (!Object.keys(c).length) return;
    track.applyConstraints({ advanced: [c] }).then(function () {
      if (mode === "single-shot" && fm.indexOf("continuous") >= 0) setTimeout(function () {
        if (cam.stream) track.applyConstraints({ advanced: [{ pointsOfInterest: poi, focusMode: "continuous" }] }).catch(function () {});
      }, 1200);
    }).catch(function () { /* 지원 안 함 */ });
  }

  // ---------- 사진 스캔 ----------
  async function scanPhoto(file) {
    if (!file) return;
    caption("사진 분석 중…");
    try {
      var zx = await loadZxing();
      var res = await zx.readBarcodes(file, { formats: ZX_FORMATS, tryHarder: true, tryRotate: true, tryInvert: false, tryDownscale: true, maxNumberOfSymbols: 8 });
      var seen = {}, codes = [];
      res.forEach(function (r) {
        var c = normCode(r.text);
        if (r.isValid && c && !/^Z/.test(c) && !seen[c]) { seen[c] = 1; codes.push({ code: c, format: zxFormat(r.format) }); }
      });
      caption("");
      if (!codes.length) { openPhotoFail(file); return; }
      var known = codes.filter(function (x) { return knownCode(x.code); });
      if (codes.length === 1 || known.length === 1) { var pick = known[0] || codes[0]; caption("인식: " + pick.code, true); resolve(pick.code, true, true); return; }
      openPhotoChoice(codes);
    } catch (e) {
      caption("");
      toast("사진을 분석하지 못했습니다: " + (e.message || e));
    }
  }
  function openPhotoChoice(codes) {
    openSheet(
      '<div class="sheet-head"><button class="cancel" data-close>닫기</button><h2>바코드 선택</h2><span></span></div>' +
      '<p class="sheet-sub">사진에서 바코드 ' + codes.length + '개를 찾았습니다</p>' +
      '<div class="group">' + codes.map(function (x) {
        var loc = isLoc(x.code), part = state.parts[x.code];
        return '<button class="row" data-photo-pick="' + esc(x.code) + '"><span class="tag ' + (loc ? "loc" : "") + '">' + (loc ? "위치" : part ? "부품" : "?") + '</span>' +
          '<div class="row-main"><div class="pn">' + esc(x.code) + '</div><div class="row-sub">' + esc(part ? part.item_nm : loc ? "부품 " + partsAt(x.code).length + "종" : "목록에 없음") + '</div></div>' + CHEV + '</button>';
      }).join("") + '</div>'
    );
  }
  function openPhotoFail(file) {
    cam.failPhoto = file;
    openSheet(
      '<div class="sheet-head"><button class="cancel" data-close>닫기</button><h2>바코드를 찾지 못함</h2><span></span></div>' +
      '<p class="sheet-sub">바코드가 사진 가운데에 크고 선명하게 나오도록 다시 찍어 주세요.<br>계속 안 되면 이 사진을 진단으로 보내 주세요.</p>' +
      '<button class="btn-primary" id="photoRetry">다시 찍기</button>' +
      '<button class="btn-ghost" id="photoDiag">이 사진을 진단으로 보내기</button>'
    );
  }

  // ---------- 진단 ----------
  function jpegOf(source, sw, sh, maxSide) {
    var k = Math.min(1, maxSide / Math.max(sw, sh));
    var c = document.createElement("canvas");
    c.width = Math.round(sw * k); c.height = Math.round(sh * k);
    c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.88).split(",")[1];
  }
  async function saveDiag(kind, b64, info) {
    var r = await sb.from("inv_scan_diag").insert({ kind: kind, device: navigator.userAgent, info: info, image_jpeg: b64, created_by: state.user.id });
    toast(r.error ? "진단 저장 실패: " + r.error.message : "진단 장면을 저장했습니다");
  }
  function diagLive() {
    var video = $("camVideo");
    if (!cam.stream || !video || !video.videoWidth) { toast("카메라가 켜져 있을 때 눌러 주세요"); return; }
    var r = scanRect(video);
    saveDiag("live", jpegOf(video, video.videoWidth, video.videoHeight, 2560), {
      engine: cam.engine, video: [video.videoWidth, video.videoHeight], zoom: cam.zoom, scan: r,
      found: cam.lastFound, caps: { zoom: cam.caps.zoom || null, focus: cam.caps.focusMode || null, torch: !!cam.caps.torch }
    });
  }
  async function diagPhoto() {
    var f = cam.failPhoto;
    if (!f) return;
    try {
      var bmp = await createImageBitmap(f);
      await saveDiag("photo", jpegOf(bmp, bmp.width, bmp.height, 2400), { size: [bmp.width, bmp.height], bytes: f.size, type: f.type });
      closeSheet();
    } catch (e) { toast("진단 저장 실패: " + e.message); }
  }
  document.addEventListener("visibilitychange", syncCamera);

  function renderScanner() {
    var host = $("scannerHost");
    var mode = '<div class="vf-mode"><button class="' + (state.mode === "bt" ? "on" : "") + '" data-mode="bt">스캐너</button><button class="' + (state.mode === "camera" ? "on" : "") + '" data-mode="camera">카메라</button></div>';
    var vf;
    if (state.mode === "camera" && store.get("camera", true)) {
      vf = '<div class="viewfinder cam" role="img" aria-label="카메라 스캔 화면"><video id="camVideo" playsinline muted autoplay></video>' +
        '<canvas id="camFreeze" hidden></canvas>' + mode + '<div class="vf-tools" id="camTools"></div>' +
        (cam.error ? '<div class="vf-off"><div>' + esc(cam.error) + '<br><button data-cam-retry>다시 시도</button></div></div>'
          : '<div class="vf-frame" id="camGuide" hidden><span></span><span></span><span></span><span></span></div><div class="vf-caption">' + IDLE_HINT + '</div>') +
        '<div class="vf-flash"></div></div>' +
        '<input type="file" id="photoInput" accept="image/*" capture="environment" hidden>';
    } else {
      vf = '<div class="viewfinder bt"><div class="bt-line"><span class="dot"></span>스캐너로 바로 스캔하세요</div>' + mode + '</div>';
    }
    stopCamera();
    host.innerHTML = '<div class="scanner">' + vf +
      '<form class="search" id="manual" autocomplete="off">' + SEARCH + '<input id="manualInput" inputmode="text" autocapitalize="characters" placeholder="품번 또는 위치 직접 입력" aria-label="품번 또는 위치"><button type="submit">조회</button></form>' +
      '<div class="suggest" id="suggest" hidden></div>' +
      '<div id="daemonNotice">' + daemonNotice() + '</div>' +
      '</div>';
    renderCamTools();
    setTimeout(syncCamera, 0);
  }

  // ---------- 스캔 탭 ----------
  function daemonNotice() {
    return daemonStale() ? '<div class="notice" style="margin:8px 0 0">DMS 연결 PC가 응답하지 않습니다. 재고는 ' + basis() + ' 기준이고, 연결될 때까지 RDC 조회·위치 변경은 할 수 없습니다.</div>' : '';
  }
  function viewIdle() {
    return '<div class="idle">' +
      '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 14V9a3 3 0 0 1 3-3h5M34 6h5a3 3 0 0 1 3 3v5M42 34v5a3 3 0 0 1-3 3h-5M14 42H9a3 3 0 0 1-3-3v-5"/><path d="M15 15v18M20 15v18M26 15v18M32 15v18" stroke-width="2.4"/></svg>' +
      '<p class="idle-title">위치나 부품 바코드를 스캔하세요</p>' +
      '<p class="idle-sub">결과가 이 아래에 바로 표시됩니다</p>' +
    '</div>';
  }

  function resultHead(kind, title) {
    var back = "";
    if (state.result.length > 1) {
      var prev = state.result[state.result.length - 2];
      back = '<button class="rback" id="rBack">' + BACK + esc(prev.code) + '</button>';
    }
    return back + '<div class="rhead"><div class="rmain"><span class="tag ' + (kind === "위치" ? "loc" : "") + '">' + kind + '</span>' +
      '<h2 class="rtitle mono" style="margin-top:6px">' + esc(title) + '</h2></div>' +
      '<button class="rclose" id="rClose" aria-label="결과 닫기">' + CLOSE + '</button></div>';
  }

  function openChecksByItem() {
    var m = {};
    state.checks.forEach(function (c) { if (!m[c.item_cd]) m[c.item_cd] = c; });
    return m;
  }

  function locRows(loc, q) {
    var list = partsAt(loc);
    var chk = openChecksByItem();
    if (q) {
      q = q.toUpperCase().replace(/\s+/g, "");
      list = list.filter(function (p) { return p.item_cd.indexOf(q) >= 0 || String(p.item_nm || "").toUpperCase().replace(/\s+/g, "").indexOf(q) >= 0; });
    }
    list.sort(state.sort === "qty" ? function (a, b) { return b.crt_qty - a.crt_qty; }
      : state.sort === "check" ? function (a, b) { return (chk[b.item_cd] ? 1 : 0) - (chk[a.item_cd] ? 1 : 0) || a.item_cd.localeCompare(b.item_cd); }
      : function (a, b) { return a.item_cd.localeCompare(b.item_cd); });
    if (!list.length) return '<div class="empty">찾는 부품이 이 위치에 없습니다</div>';
    return '<div class="group">' + list.map(function (p) {
      var c = chk[p.item_cd];
      var d = c ? c.counted_qty - checkBase(c) : 0, rr = rrQty(p.item_cd);
      return '<div class="prow">' +
        '<button class="row-btn" data-go="' + esc(p.item_cd) + '"><div class="row-main"><div class="pn">' + esc(p.item_cd) + '</div><div class="row-sub">' + esc(p.item_nm) + '</div>' + splitNote(p.crt_qty, rr) +
        (c ? '<div class="diff-note">실사 ' + qtyNum(c.counted_qty) + ' · 차이 ' + (d > 0 ? "+" : "−") + Math.abs(qtyNum(d)) + '</div>' : '') +
        '</div><div class="qty">' + qtyNum(Number(p.crt_qty) + rr) + '<small>EA</small></div></button>' +
        '<button class="check' + (c ? " on" : "") + '" data-check="' + esc(p.item_cd) + '" aria-label="' + esc(p.item_cd) + ' 수량 다름 체크"><i></i></button>' +
      '</div>';
    }).join("") + '</div>';
  }

  function viewLoc(loc) {
    var list = partsAt(loc);
    var chk = openChecksByItem();
    var q = state.locQ && state.locQ.loc === loc ? state.locQ.q : "";
    var total = list.reduce(function (s, p) { return s + Number(p.crt_qty) + rrQty(p.item_cd); }, 0);
    var checked = list.filter(function (p) { return chk[p.item_cd]; }).length;
    return resultHead("위치", loc) +
      '<p class="meta" style="margin-bottom:12px">해운대 부품창고 · ' + basis() + ' 기준</p>' +
      '<div class="summary"><div><b>' + list.length + '</b><span>부품 종류</span></div><div><b>' + qtyNum(total).toLocaleString() + '</b><span>총 수량</span></div><div class="' + (checked ? "w" : "") + '"><b>' + checked + '</b><span>수량 다름</span></div></div>' +
      (list.length > 12 ? '<div class="search" style="margin-top:0">' + SEARCH + '<input id="locSearch" value="' + esc(q) + '" placeholder="이 위치에서 품번·품명 찾기" aria-label="이 위치에서 찾기"></div>' : '') +
      '<div class="seg" role="tablist">' +
        '<button data-sort="pn" class="' + (state.sort === "pn" ? "on" : "") + '">품번순</button>' +
        '<button data-sort="qty" class="' + (state.sort === "qty" ? "on" : "") + '">수량 많은순</button>' +
        '<button data-sort="check" class="' + (state.sort === "check" ? "on" : "") + '">체크 먼저</button>' +
      '</div>' +
      '<div id="locList">' + locRows(loc, q) + '</div>' +
      '<p class="footnote">수량이 다르면 오른쪽 동그라미를 눌러 실사 수량을 남기세요.</p>';
  }

  function rdcTile(pn) {
    var r = state.rdc[pn];
    if (!r) {
      return '<div class="tile-label">RDC 재고</div><button class="btn-secondary rdc-btn" data-rdc-retry="' + esc(pn) + '">RDC 조회</button><div class="tile-foot">눌러서 DMS에서 조회</div>';
    }
    if (r.status === "pending") {
      return '<div class="tile-label">RDC 재고</div><div class="shimmer"></div><div class="tile-foot">' + (daemonStale() ? "DMS 연결 대기 중" : "DMS에서 조회 중") + '</div>';
    }
    if (r.status === "failed") {
      return '<div class="tile-label">RDC 재고</div><div class="rdc-err">' + esc(r.error || "조회 실패") + '</div><div class="tile-foot"><button class="btn-inline" data-rdc-retry="' + esc(pn) + '">다시 조회</button></div>';
    }
    var q = qtyNum(r.result && r.result.rdc_qty || 0);
    return '<div class="tile-label">RDC 재고</div><div class="tile-num' + (q ? "" : " zero") + '">' + q.toLocaleString() + '<small>EA</small></div><div class="tile-foot">' + hhmm(r.at) + ' 조회 · <button class="btn-inline" data-rdc-retry="' + esc(pn) + '">다시</button></div>';
  }

  // RR 재고: 같은 자리에 BMW·RR 부품이 함께 있어 센 수량은 합계 → 비교는 BMW + RR
  function rrQty(pn) { var r = state.rrParts[pn]; return r ? Number(r.crt_qty) || 0 : 0; }
  // 재고조사 항목: 조사 시작 때 고정한 RR 수량, 없으면(이 기능 전에 시작한 조사) 최신 RR 현재고
  function itemRr(it) { return it.rr_qty != null ? Number(it.rr_qty) : rrQty(it.item_cd); }
  function itemTotal(it) { return Number(it.qty) + itemRr(it); }
  // RR 수량을 아는지: 조사 시작 때 고정했거나, RR 현재고가 한 번이라도 올라왔으면
  function itemRrKnown(it) { return it.rr_qty != null || !!rrBasis() || Object.keys(state.rrParts).length > 0; }
  // 체크 기록의 비교 기준 (DMS + RR)
  function checkBase(c) { return Number(c.dms_qty) + (Number(c.rr_qty) || 0); }
  function splitNote(bmw, rr) { return rr ? '<div class="row-sub rr-split">BMW ' + qtyNum(bmw) + ' + RR ' + qtyNum(rr) + '</div>' : ''; }
  function rrBasis() { return state.status && state.status.rr_parts_at ? hhmm(state.status.rr_parts_at) : null; }
  function rrTile(pn) {
    var label = '<div class="tile-label">RR 재고</div>', at = rrBasis();
    if (!at) return label + '<div class="tile-num zero">-</div><div class="tile-foot">' + esc(rrProblem() || "아직 올라오지 않음") + '</div>';
    var p = state.rrParts[pn], q = qtyNum(p ? p.crt_qty : 0);
    return label + '<div class="tile-num' + (q ? "" : " zero") + '">' + q.toLocaleString() + '<small>EA</small></div>' +
      '<div class="tile-foot">' + (p ? (p.lct_cd ? '<span class="mono-loc">' + esc(p.lct_cd) + '</span> · ' : '') : 'RR 부품창고에 없음 · ') +
      at + ' 기준' + (rrProblem() ? ' · <span style="color:var(--danger)">갱신 안 됨</span>' : '') + '</div>';
  }

  function moveBanner(pn) {
    var m = state.moves[pn];
    if (!m) return "";
    if (m.status === "pending") return '<div class="banner info"><span class="spin" aria-hidden="true"></span>DMS 반영 중 · ' + esc(m.from || "공란") + ' → ' + esc(m.to) + '</div>';
    if (m.status === "failed") m.seen = true;   // 부품 화면에서 봤으면 위쪽 띠는 내림
    if (m.status === "failed") return '<div class="banner">위치 변경 실패 · ' + esc(m.error || "") + '</div>';
    return '<div class="banner ok">DMS 반영 완료 · ' + esc(m.from || "공란") + ' → ' + esc(m.to) + ' · ' + m.time + '</div>';
  }

  // 화면 위 띠: 위치 변경이 진행 중이면 어느 탭에서든 보이고, 끝나면 완료(잠시)·실패(누를 때까지) 표시
  var MOVE_DONE_SHOW_MS = 6000, moveBarTimer = null, moveBarPn = null;
  function renderMoveBar() {
    var bar = $("moveBar"), now = Date.now();
    var list = Object.keys(state.moves).map(function (k) { return Object.assign({ pn: k }, state.moves[k]); })
      .filter(function (m) { return m.status === "pending" || m.status === "failed" && !m.seen || m.status === "done" && now - m.at < MOVE_DONE_SHOW_MS; });
    clearTimeout(moveBarTimer);
    if (!state.user || !list.length) { bar.hidden = true; moveBarPn = null; return; }
    var pending = list.filter(function (m) { return m.status === "pending"; });
    var failed = list.filter(function (m) { return m.status === "failed"; });
    var m = pending[0] || failed[0] || list[0];
    var route = ' <b class="mono-loc">' + esc(m.from || "공란") + ' → ' + esc(m.to) + '</b>';
    var text = m.status === "pending" ? '<span class="spin" aria-hidden="true"></span><span class="mb-text">위치 변경 중 · <b>' + esc(m.pn) + '</b>' + route + '</span>'
      : m.status === "failed" ? '<span class="mb-text">위치 변경 실패 · <b>' + esc(m.pn) + '</b> ' + esc(m.error || "") + '</span>'
      : '<span class="mb-text">DMS 반영 완료 · <b>' + esc(m.pn) + '</b>' + route + '</span>';
    var more = pending.length > 1 ? '<span class="mb-more">외 ' + (pending.length - 1) + '건</span>' : '';
    bar.className = "movebar" + (m.status === "failed" ? " err" : m.status === "done" ? " ok" : "");
    bar.innerHTML = text + more;
    bar.hidden = false;
    moveBarPn = m.pn;
    if (!pending.length && !failed.length) moveBarTimer = setTimeout(renderMoveBar, MOVE_DONE_SHOW_MS - (now - m.at) + 50);
  }
  $("moveBar").addEventListener("click", function () {
    var pn = moveBarPn, m = pn && state.moves[pn];
    if (!m) return;
    if (m.status === "failed") m.seen = true;
    if (state.parts[pn]) { closeSheet(); state.tab = "scan"; state.result = [{ type: "part", code: pn }]; render(true); }
    else renderMoveBar();
  });

  // ---------- 부품별 마지막 재고조사 (참고용) ----------
  // 일일·일일장기·주간 재고조사에서 일치/수량 다름으로 확인한 기록 중 가장 최근 것 (부품마다 한 번 받아 둠)
  var lastAudits = {};   // pn → { rows: [...], at } | { loading: true }
  var KIND_SHORT = { daily: "일일", aging: "일일장기", weekly: "주간" };
  function loadLastAudit(pn) {
    var cur = lastAudits[pn];
    if (cur && (cur.loading || Date.now() - cur.at < 60000)) return;
    lastAudits[pn] = { loading: true, rows: cur && cur.rows };
    sb.from("inv_audit_items").select("audit_id,status,counted,qty,rr_qty,checked_at,checked_by_name,memo,inv_audits(kind)")
      .eq("item_cd", pn).not("status", "is", null).order("checked_at", { ascending: false }).limit(3)
      .then(function (r) {
        lastAudits[pn] = { rows: r.error ? (cur && cur.rows) || null : r.data || [], at: r.error ? 0 : Date.now() };
        document.querySelectorAll('[data-last="' + pn + '"]').forEach(function (el) {
          el.innerHTML = lastAuditHtml(pn, el.getAttribute("data-skip") || null, el.classList.contains("lastaudit"), true);
        });
      });
  }
  // skipAudit: 지금 하고 있는 조사는 빼고 그 전 것 (재고 확인 창)
  function lastAuditHtml(pn, skipAudit, tile, loaded) {
    if (!loaded) loadLastAudit(pn);
    var c = lastAudits[pn];
    if (!c || !c.rows) return c && !c.loading && !c.rows ? '' : '<span class="la-dim">재고조사 이력 확인 중…</span>';
    var x = c.rows.filter(function (r) { return r.audit_id !== skipAudit; })[0];
    if (!x) return '<span class="la-dim">' + (tile ? '재고조사 이력 없음' : '이전 재고조사 이력 없음') + '</span>';
    var d = new Date(x.checked_at), when = (d.getMonth() + 1) + "/" + d.getDate();
    var kind = KIND_SHORT[x.inv_audits && x.inv_audits.kind] || "";
    var base = Number(x.qty) + (Number(x.rr_qty) || 0);
    var res = x.status === "ok" ? '<b class="la-ok">일치</b>'
      : '<b class="la-diff">수량 다름</b> 실사 ' + qtyNum(x.counted) + ' / DMS ' + qtyNum(base);
    var who = x.checked_by_name ? ' · ' + esc(x.checked_by_name) : '';
    return tile
      ? '<div class="la-head">마지막 재고조사</div><div>' + when + ' ' + kind + who + '</div><div>' + res + '</div>' + (x.memo ? '<div class="la-memo">' + esc(x.memo) + '</div>' : '')
      : (skipAudit ? '지난 재고조사 ' : '마지막 재고조사 ') + when + ' ' + kind + ' · ' + res + who;
  }

  function viewPart(pn) {
    var p = state.parts[pn];
    var c = openChecksByItem()[pn];
    var moving = state.moves[pn] && state.moves[pn].status === "pending";
    return resultHead("부품", pn) +
      '<p class="meta" style="margin-bottom:12px">' + esc(p.item_nm) + '</p>' +
      '<div class="stock">' +
        '<div class="tile"><div class="tile-label">지점 현재고</div><div class="tile-num' + (Number(p.crt_qty) ? "" : " zero") + '">' + qtyNum(p.crt_qty) + '<small>EA</small></div>' +
          (p.lct_cd ? '<button class="loc-btn" data-go="' + esc(p.lct_cd) + '"><span>위치</span><b class="mono-loc">' + esc(p.lct_cd) + '</b> ›</button>' : '<span class="tag warn" style="margin-top:10px">위치 없음</span>') +
          '<div class="lastaudit" data-last="' + esc(pn) + '">' + lastAuditHtml(pn, null, true) + '</div>' +
        '</div>' +
        '<div class="tile rdc" id="rrTile" data-pn="' + esc(pn) + '">' + rrTile(pn) + '</div>' +
        '<div class="tile rdc" id="rdcTile" data-pn="' + esc(pn) + '">' + rdcTile(pn) + '</div>' +
      '</div>' +
      moveBanner(pn) +
      (c ? '<div class="banner">수량 다름 체크됨 · DMS ' + qtyNum(c.dms_qty) + (Number(c.rr_qty) ? ' + RR ' + qtyNum(c.rr_qty) : '') + ' / 실사 ' + qtyNum(c.counted_qty) + (c.memo ? ' · ' + esc(c.memo) : '') + '</div>' : '') +
      '<div class="section-label">부품 정보</div>' +
      '<div class="group">' +
        '<div class="row"><div class="row-main">위치</div><span class="row-value mono-loc">' + esc(p.lct_cd || "없음") + '</span></div>' +
        '<div class="row"><div class="row-main">ALOIS</div><span class="row-value">' + esc(p.alois_cd || "-") + (GROUPS[(p.alois_cd || "")[0]] ? ' · ' + GROUPS[p.alois_cd[0]] : '') + '</span></div>' +
        '<div class="row"><div class="row-main">최종 입고</div><span class="row-value">' + esc(p.last_purc_dt || "-") + '</span></div>' +
        '<div class="row"><div class="row-main">재고 기준</div><span class="row-value">' + basis() + ' · 10분마다 갱신</span></div>' +
      '</div>' +
      '<div class="section-label">작업</div>' +
      '<div class="group">' +
        (moving ? '<div class="row"><div class="row-main" style="color:var(--label2)">위치 변경 · DMS 반영 중</div></div>'
          : '<button class="row" data-move="' + esc(pn) + '"><div class="row-main row-link">위치 변경</div>' + CHEV + '</button>') +
        '<button class="row" data-check="' + esc(pn) + '"><div class="row-main row-link">' + (c ? "체크 내용 수정" : "수량 다름 체크") + '</div>' + CHEV + '</button>' +
        '<button class="row" data-refresh="' + esc(pn) + '"><div class="row-main row-link">DMS 현재고 다시 조회</div>' + CHEV + '</button>' +
        '<button class="row" data-movelog="' + esc(pn) + '"><div class="row-main row-link">이 부품 위치 변경 이력</div>' + CHEV + '</button>' +
      '</div>';
  }

  function viewScan() {
    var r = state.result.length ? state.result[state.result.length - 1] : null;
    if (r && r.type === "loc" && !isLoc(r.code)) r = null;
    if (r && r.type === "part" && !state.parts[r.code]) r = null;
    var body = !r ? viewIdle() : r.type === "loc" ? viewLoc(r.code) : viewPart(r.code);
    return '<div id="result">' + body + '</div>';
  }

  function unknownRr(pn) {
    var p = state.rrParts[pn];
    if (!p) return "";
    return '<div class="bigqty"><span>RR 재고</span><b>' + qtyNum(p.crt_qty) + '</b><small>EA</small></div>' +
      '<p class="sheet-sub">' + esc(p.item_nm || "") + ' · RR 위치 ' + esc(p.lct_cd || "없음") + ' · ' + rrBasis() + ' 기준</p>';
  }
  // 현재고 목록에 없는 품번: DMS에서 직접 조회할지 묻기
  function openUnknownPart(pn) {
    openSheet(
      '<div class="sheet-head"><button class="cancel" data-close>닫기</button><h2>목록에 없는 품번</h2><span></span></div>' +
      '<div class="sheet-loc mono-loc">' + esc(pn) + '</div>' +
      '<p class="sheet-sub">' + basis() + ' 기준 BMW 부품창고 현재고 목록에 없습니다.<br>재고가 0이거나 다른 창고에 있을 수 있습니다.</p>' +
      '<button class="btn-primary" id="unknownLookup" data-pn="' + esc(pn) + '">BMW DMS에서 조회</button>' +
      '<div id="unknownResult"></div>' + unknownRr(pn)
    );
  }

  // ---------- 재고조사 ----------
  function currentAudit() {
    var a = state.audits[state.auditOpen], s = state.sources[state.auditOpen];
    if (!a || !s) return a || null;
    return (a.period_start === s.period_start && a.period_end === s.period_end) ? a : null;
  }
  function auditStatsOf(items) {
    var done = 0, diff = 0;
    items.forEach(function (it) { if (it.status) done++; if (it.status === "diff") diff++; });
    return { done: done, diff: diff, total: items.length, left: items.length - done };
  }
  function progressBar(s) {
    var pct = s.total ? Math.round(100 * s.done / s.total) : 0;
    return '<div class="pbar" role="progressbar" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100"><i style="width:' + pct + '%"></i></div>';
  }
  function periodLabel(kind, s) {
    if (!s) return "목록 준비 중";
    var md = function (d) { var x = d.split("-"); return Number(x[1]) + "/" + Number(x[2]); };
    if (kind === "aging") return md(s.period_start) + " 장기재고 무작위 " + (s.items ? s.items.length : s.item_count) + "건";
    return kind === "daily" ? md(s.period_start) + " 입고분" : md(s.period_start) + " ~ " + md(s.period_end) + " 출고분";
  }
  var AUDIT_TITLE = { daily: "일일 재고조사", aging: "일일장기 재고조사", weekly: "주간 재고조사" };
  var AUDIT_RULE = { daily: "오늘 입고된 부품 중 현재고가 있는 부품", weekly: "지난주 월~토 출고된 부품 중 현재고가 있는 부품",
    aging: "최종입고·최종출고가 180일 넘은 부품(출고 이력 없음 포함) 중 하루 10개 무작위. 한 바퀴 돌 때까지 겹치지 않고, 최근 180일 안에 재고조사로 확인한 부품은 빠짐" };
  var auditCounts = {};   // audit_id -> {done, diff} (홈 카드용)

  function viewAuditHome() {
    var cards = ["daily", "aging", "weekly"].map(function (k) {
      var s = state.sources[k], a = state.audits[k];
      var live = a && s && a.period_start === s.period_start && a.period_end === s.period_end ? a : null;
      var st = live && auditCounts[live.id];
      var total = live ? live.item_count : (s ? s.items.length : 0);
      var status = !live ? '<span class="pill">시작 전</span>'
        : live.finished_at ? '<span class="pill ok">종료</span>'
        : st && st.done === total ? '<span class="pill ok">완료</span>' : '<span class="pill run">진행 중</span>';
      var foot = !live ? total + '건 · 시작하면 목록이 고정됩니다'
        : (st ? st.done : 0) + ' / ' + total + ' 확인' + (st && st.diff ? ' · <b class="warn-text">수량 다름 ' + st.diff + '</b>' : '') + ' · ' +
          (live.finished_at ? hhmm(live.finished_at) + ' ' + esc(live.finished_by_name || "") + ' 종료' : hhmm(live.started_at) + ' ' + esc(live.started_by_name || "") + ' 시작');
      return '<button class="acard" data-audit="' + k + '"' + (s ? '' : ' disabled') + '>' +
        '<div class="acard-top"><div class="row-main"><div class="acard-title">' + AUDIT_TITLE[k] + '</div><div class="row-sub">' + periodLabel(k, s) + '</div></div>' + status + CHEV + '</div>' +
        (live && st ? progressBar({ done: st.done, total: total }) : '') +
        '<div class="acard-foot">' + foot + '</div></button>';
    }).join("");
    return '<h1 class="large">재고조사</h1><p class="meta">해운대 부품창고 · 위치 순서대로 확인</p>' +
      '<div class="acards">' + cards + '</div>' +
      '<p class="footnote">일일: ' + AUDIT_RULE.daily + '<br>일일장기: ' + AUDIT_RULE.aging + '<br>주간: ' + AUDIT_RULE.weekly + '<br>수량은 그 부품의 현재고 전체입니다.</p>';
  }

  // 일일장기: 전에 뽑혔는데 확인 안 돼 넘어온 부품 → "이월 10/8" (처음 뽑힌 날)
  function carryLabel(it) { if (!it.carry_from) return ""; var x = String(it.carry_from).split("-"); return "이월 " + Number(x[1]) + "/" + Number(x[2]); }
  function carryTag(it) { return it.carry_from ? ' <span class="tag warn carry">' + carryLabel(it) + '</span>' : ''; }

  function auditRows(items, started) {
    var list = items.filter(function (it) {
      if (state.auditLoc && it.lct_cd !== state.auditLoc) return false;
      if (!started) return true;
      if (state.auditFilter === "left") return !it.status;
      if (state.auditFilter === "diff") return it.status === "diff";
      return true;
    });
    if (!list.length) {
      var msg = state.auditFilter === "left" ? (state.auditLoc ? "이 위치는 모두 확인했습니다" : "남은 부품이 없습니다") : state.auditFilter === "diff" ? "수량이 다른 부품이 없습니다" : "목록이 비어 있습니다";
      return '<div class="empty">' + msg + '</div>';
    }
    var html = "", cur = null;
    list.forEach(function (it) {
      var loc = it.lct_cd || "";
      if (loc !== cur) {
        if (cur !== null) html += '</div>';
        cur = loc;
        var locItems = items.filter(function (x) { return (x.lct_cd || "") === cur; });
        var locLeft = locItems.filter(function (x) { return !x.status; }).length;
        html += '<div class="loc-head"><span class="mono-loc">' + esc(cur || "위치 없음") + '</span><span>' + (started ? (locLeft ? locLeft + '건 남음' : '완료') : locItems.length + '건') + '</span></div><div class="group">';
      }
      var mark = (it.pending ? '<span class="pill">전송 대기</span>' : '') +
        (it.status === "ok" ? '<span class="pill ok">일치</span>'
        : it.status === "diff" ? '<span class="pill warn">실사 ' + qtyNum(it.counted) + '</span>' : '');
      html += '<button class="row' + (it.status ? " done" : "") + '" data-aitem="' + esc(it.item_cd) + '"' + (started ? '' : ' disabled') + '>' +
        '<div class="row-main"><div class="pn">' + esc(it.item_cd) + carryTag(it) + '</div><div class="row-sub">' + esc(it.item_nm) + (it.checked_by_name ? ' · ' + esc(it.checked_by_name) : '') + '</div>' + splitNote(it.qty, itemRr(it)) + movedNote(it) + '</div>' +
        '<div class="qty">' + qtyNum(itemTotal(it)) + '<small>EA</small></div>' + mark + '</button>';
    });
    return html + '</div>';
  }

  // 조사 시작 때 수량과 최근 DMS 현재고(10분마다 갱신) 차이 — 시작 뒤 출고·입고 (기다림 없이 바로)
  function syncNow(it) {
    if (!Object.keys(state.parts).length) return null;
    var p = state.parts[it.item_cd];
    return { bmw: p ? Number(p.crt_qty) || 0 : 0, lct: p ? p.lct_cd : null };
  }
  // 수량을 DMS 갱신했으면 그때부터, 아니면 조사 시작부터의 변화
  function sinceLabel() { var a = currentAudit(); return a && a.qty_refreshed_at ? "수량 갱신 뒤" : "조사 시작 뒤"; }
  function movedSince(it) {
    var n = syncNow(it);
    return n ? n.bmw + (itemRrKnown(it) ? rrQty(it.item_cd) : 0) - itemTotal(it) : 0;
  }
  function movedNote(it) {
    var d = movedSince(it);
    return d ? '<div class="row-sub warn-text">' + sinceLabel() + ' ' + (d > 0 ? '+' : '−') + qtyNum(Math.abs(d)) + ' (지금 ' + qtyNum(itemTotal(it) + d) + ')</div>' : '';
  }

  function viewAuditList() {
    var k = state.auditOpen, s = state.sources[k], a = currentAudit();
    // 진행 중인 조사: 제목 옆 작은 버튼으로 남은 부품 수량을 데몬 마지막 주기 DMS 현재고로 갱신
    var canRefresh = a && !a.finished_at && state.auditItems.some(function (it) { return !it.status; });
    var head = '<button class="rback" id="auditBack">' + BACK + '재고조사</button>' +
      '<div class="rhead"><div class="rmain rtitle-row"><h2 class="rtitle">' + AUDIT_TITLE[k] + '</h2>' +
        (canRefresh ? '<button class="title-btn" id="auditRefresh" aria-label="남은 부품 수량·위치를 최근 DMS 현재고로 갱신">' + REFRESH + 'DMS 갱신</button>' : '') +
      '</div></div>' +
      '<p class="meta" style="margin-bottom:12px">' + periodLabel(k, s) + (a ? ' · ' + hhmm(a.started_at) + ' 시작' : '') +
        (a && a.qty_refreshed_at ? ' · 수량·위치 ' + hhmm(a.qty_basis_at || a.qty_refreshed_at) + ' DMS 기준' : '') +
        (a && a.qty_removed && a.qty_removed.length ? ' · 재고 0으로 ' + a.qty_removed.length + '건 뺌' : '') + '</p>';
    if (!a) {
      var items = (s ? s.items : []).map(function (x) { return { item_cd: x.item_cd, item_nm: x.item_nm, lct_cd: x.lct_cd, qty: x.qty, carry_from: x.carry_from }; });
      items.sort(function (x, y) { return (x.lct_cd || "~").localeCompare(y.lct_cd || "~") || x.item_cd.localeCompare(y.item_cd); });
      var locN = {}; items.forEach(function (x) { locN[x.lct_cd || ""] = 1; });
      return head +
        '<div class="summary"><div><b>' + items.length + '</b><span>조사할 부품</span></div><div><b>' + Object.keys(locN).length + '</b><span>위치</span></div></div>' +
        '<button class="btn-primary" id="auditStart" style="margin-top:0"' + (items.length ? '' : ' disabled') + '>조사 시작</button>' +
        '<p class="footnote">시작하면 지금 목록(' + items.length + '건)으로 고정됩니다.' + (k === "daily" ? ' 이후 입고되는 부품은 다음 조사에 들어갑니다.' : k === "aging" ? ' 목록은 오늘 하루 동안 같고, 내일은 다른 10개가 뽑힙니다.' : '') + '</p>' +
        '<div class="section-label">조사할 부품 미리보기</div>' + auditRows(items, false);
    }
    var st = auditStatsOf(state.auditItems), done = !!a.finished_at;
    return head +
      '<div class="aprog"><div class="aprog-nums"><b>' + st.done + '</b> / ' + st.total + ' 확인' + (st.diff ? ' · <span class="warn-text">수량 다름 ' + st.diff + '</span>' : '') + '</div>' + progressBar(st) + '</div>' +
      (!done && state.auditItems.length && !itemRrKnown(state.auditItems[0]) ? '<div class="notice">RR 재고가 아직 올라오지 않아 BMW 수량만으로 비교합니다. DMS 연결 PC(데몬)를 확인하세요.</div>' : '') +
      (done ? '<div class="banner ok">' + hhmm(a.finished_at) + ' ' + esc(a.finished_by_name || "") + ' 종료 · 더 이상 고칠 수 없습니다</div>' +
          '<button class="btn-primary" id="auditReport" style="margin:0 0 8px">보고서 보기 · PDF 저장</button>' +
          '<button class="btn-ghost" id="auditReopen" style="margin:0 0 12px">다시 시작 (이어서 확인)</button>'
        : st.left === 0 ? '<div class="banner ok">모두 확인했습니다 · 수량 다름 ' + st.diff + '건은 체크 기록에 있습니다</div>' +
          '<button class="btn-primary" id="auditFinish" style="margin:0 0 12px">조사 종료 · 보고서 만들기</button>' : '') +
      (state.auditLoc ? '<div class="locchip"><span>위치 <b class="mono-loc">' + esc(state.auditLoc) + '</b>만 보는 중' + (locScanned(state.auditLoc) ? ' · 스캔함' : ' · <b>스캔해야 확인 가능</b>') + '</span><button id="auditLocClear" aria-label="위치 필터 해제">' + CLOSE + '</button></div>' : '') +
      '<div class="seg" role="tablist">' +
        '<button data-afilter="left" class="' + (state.auditFilter === "left" ? "on" : "") + '">남은 것 ' + st.left + '</button>' +
        '<button data-afilter="diff" class="' + (state.auditFilter === "diff" ? "on" : "") + '">수량 다름 ' + st.diff + '</button>' +
        '<button data-afilter="all" class="' + (state.auditFilter === "all" ? "on" : "") + '">전체 ' + st.total + '</button>' +
      '</div>' +
      auditRows(state.auditItems, !done) +
      (done ? '' : (st.left ? '<button class="btn-ghost" id="auditFinish">조사 종료</button>' : '') +
        '<p class="footnote">위치 바코드를 찍으면 그 위치만 보이고, 부품 바코드를 찍으면 확인 창이 열립니다. 다 마치면 "조사 종료"를 눌러 보고서를 만드세요.</p>');
  }

  function viewAudit() {
    if (!state.auditOpen) return viewAuditHome();
    return '<div id="result">' + viewAuditList() + '</div>';
  }

  function findAuditItem(pn) { for (var i = 0; i < state.auditItems.length; i++) if (state.auditItems[i].item_cd === pn) return state.auditItems[i]; return null; }

  function auditScan(code, via) {
    if (currentAudit().finished_at) { toast("종료된 조사입니다"); return; }
    var it = findAuditItem(code);
    if (it) { pushRecent(code); if (via) markScanned("#" + code, "part"); openAuditItem(code); return; }
    var n = state.auditItems.filter(function (x) { return x.lct_cd === code; }).length;
    if (n) {
      if (via) markScanned(code, via);
      state.auditLoc = code; state.auditFilter = "left";
      render(false); scrollToResult();
      return;
    }
    var gone = (currentAudit().qty_removed || []).filter(function (x) { return x.item_cd === code; })[0];
    if (gone) { toast("DMS 재고 0이라 목록에서 뺀 부품입니다. 실물이 있으면 스캔 탭에서 수량 다름으로 체크하세요"); return; }
    toast("이 조사 목록에 없는 바코드입니다: " + code);
  }

  // ---------- 현장 확인 (위치 스캔해야 일치·수량 다름) ----------
  // 조사마다 스캐너·카메라로 찍은 위치(그리고 부품 바코드 "#품번")와 시각을 이 휴대폰에 둠 — 그 조사가 끝날 때까지 유효
  var scanned = store.get("auditScans", {});
  var sheetExempt = {};   // 이 창에서 사유를 적고 연 부품 (창을 닫으면 사라짐)
  function markScanned(key, via) {
    var a = currentAudit();
    if (!a) return;
    var keep = {}; keep[a.id] = scanned[a.id] || {};   // 지난 조사 기록은 버림
    keep[a.id][key] = { via: via, at: new Date().toISOString() };
    scanned = keep; store.set("auditScans", scanned);
  }
  // 이 부품을 확인할 수 있는 근거: 위치 스캔 / 부품 바코드 스캔 / 예외(사유). 없으면 null
  function proofOf(it) {
    var a = currentAudit(), m = (a && scanned[a.id]) || {};
    var loc = it.lct_cd && m[it.lct_cd], part = m["#" + it.item_cd];
    if (loc && (!part || loc.at >= part.at)) return { via: loc.via, at: loc.at };
    if (part) return { via: "part", at: part.at };
    if (sheetExempt[it.item_cd]) return { via: "exempt", at: null, reason: sheetExempt[it.item_cd] };
    return null;
  }
  function auditSheetScan(code, via) {
    var pn = $("aLock").getAttribute("data-pn"), it = findAuditItem(pn);
    if (code === pn) { markScanned("#" + pn, "part"); openAuditItem(pn); return; }
    if (it.lct_cd && code === it.lct_cd) { markScanned(code, via); openAuditItem(pn); return; }
    if (state.auditItems.some(function (x) { return x.lct_cd === code; })) markScanned(code, via);   // 다른 위치도 찍은 걸로 둠
    toast("이 부품의 위치가 아닙니다: " + code + (it.lct_cd ? " (이 부품은 " + it.lct_cd + ")" : ""));
  }
  function locScanned(loc) { var a = currentAudit(); return !!(a && scanned[a.id] && scanned[a.id][loc]); }
  function proofLabel(p) {
    var t = p.at ? ' · ' + hhmm(p.at) : '';
    return p.via === "exempt" ? '예외로 확인 · ' + esc(p.reason)
      : (p.via === "part" ? '부품 바코드 스캔함' : '위치 스캔함 (' + (p.via === "camera" ? '카메라' : '스캐너') + ')') + t;
  }
  function lockHtml(it) {
    return '<div class="lockbox" id="aLock" data-pn="' + esc(it.item_cd) + '">' +
      '<div class="lock-t">🔒 ' + (it.lct_cd ? '위치 <b class="mono-loc">' + esc(it.lct_cd) + '</b> 를 스캔하면 확인할 수 있습니다' : '위치 없는 부품 — 부품 바코드를 스캔하세요') + '</div>' +
      '<div class="lock-s">위치 라벨이나 부품 바코드를 스캐너·카메라로 찍으세요 (직접 입력은 안 됨)</div>' +
      '<button class="btn-inline" id="aExemptToggle">스캔할 수 없나요? (사유 적고 확인)</button>' +
      '<div id="aExemptBox" hidden><div class="group" style="margin-top:6px"><div class="row"><textarea class="field" id="aExemptIn" rows="2" placeholder="사유 (예: 위치 라벨 없음, 바코드 훼손)" aria-label="스캔 못 한 사유"></textarea></div></div>' +
        '<button class="btn-ghost" id="aExemptGo" data-pn="' + esc(it.item_cd) + '">사유 적고 확인하기</button>' +
        '<div class="lock-s">예외로 확인한 건은 보고서에 따로 표시됩니다</div></div>' +
    '</div>';
  }

  function openAuditItem(pn) {
    var it = findAuditItem(pn), curA = currentAudit(), proof = proofOf(it), locked = !proof;
    var prev = it.status === "ok" ? '<p class="sheet-sub">' + hhmm(it.checked_at) + ' ' + esc(it.checked_by_name || "") + ' · 일치로 확인함</p>'
      : it.status === "diff" ? '<p class="sheet-sub warn-text">' + hhmm(it.checked_at) + ' ' + esc(it.checked_by_name || "") + ' · 실사 ' + qtyNum(it.counted) + '개로 기록함</p>' : '';
    openSheet(
      '<div class="sheet-head"><button class="cancel" data-close>닫기</button><h2>재고 확인</h2><span></span></div>' +
      '<div class="sheet-loc mono-loc">' + esc(it.lct_cd || "위치 없음") + '</div>' +
      '<div class="sheet-pn">' + esc(pn) + carryTag(it) + '</div>' +
      '<p class="sheet-sub" style="margin-bottom:4px">' + esc(it.item_nm) + '</p>' +
      '<p class="lastaudit-line" data-last="' + esc(pn) + '" data-skip="' + esc(curA ? curA.id : "") + '">' + lastAuditHtml(pn, curA ? curA.id : null, false) + '</p>' +
      '<div class="bigqty"><span>BMW + RR 합계</span><b>' + qtyNum(itemTotal(it)) + '</b><small>EA</small></div>' +
      '<div class="qsplit"><div><span>BMW</span><b>' + qtyNum(it.qty) + '</b></div><div><span>RR</span><b>' + (itemRrKnown(it) ? qtyNum(itemRr(it)) : "-") + '</b></div></div>' +
      (itemRrKnown(it) ? '' : '<div class="notice">RR 재고가 아직 올라오지 않아 BMW 수량만 합계에 들어 있습니다. DMS 연결 PC(데몬)를 확인하세요.</div>') +
      '<div class="nowbox" id="aNow" data-pn="' + esc(pn) + '">' + (syncNow(it)
        ? auditNowHtml(it, syncNow(it).bmw, syncNow(it).lct, '최근 DMS', basis() + ' 기준')
        : '<button class="btn-secondary" id="aNowBtn">현재 DMS 재고 조회</button><div class="nowbox-hint">' + sinceLabel() + ' 출고·입고로 바뀌었는지 확인</div>') + '</div>' + prev +
      (locked ? lockHtml(it) : '<div class="proof-line">' + proofLabel(proof) + '</div>') +
      '<button class="btn-primary" id="aOk" data-pn="' + esc(pn) + '"' + (locked ? ' hidden' : '') + '>일치</button>' +
      '<button class="btn-ghost" id="aDiffToggle"' + (locked ? ' hidden' : '') + '>수량 다름</button>' +
      '<div id="aDiffBox" hidden>' +
        '<div class="group" style="margin-top:12px"><div class="row stepper"><div class="row-main">실사 수량</div><div class="stepper-ctl"><button type="button" data-astep="-1" aria-label="하나 빼기">−</button><input id="aCountIn" type="text" inputmode="numeric" autocomplete="off" class="qty-in" value="' + qtyNum(it.status === "diff" ? it.counted : itemTotal(it)) + '" aria-label="실사 수량"><button type="button" data-astep="1" aria-label="하나 더하기">+</button></div></div>' +
        '<div class="row"><textarea class="field" id="aMemoIn" rows="2" placeholder="메모 (선택)" aria-label="메모"></textarea></div></div>' +
        '<button class="btn-primary" id="aDiffSave" data-pn="' + esc(pn) + '">수량 다름으로 저장</button>' +
      '</div>'
    );
  }

  // 재고 확인 창: 조사 시작 때 수량(스냅샷)과 지금 DMS 수량 비교 — 시작 뒤 출고·입고된 부품 확인용
  async function auditNow(btn) {
    var box = $("aNow"), pn = box.getAttribute("data-pn");
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> DMS에서 조회 중…';
    try {
      var id = await sendRequest("stock", pn);
      waitRequest(id, function (res) {
        var b = $("aNow");
        if (!b || b.getAttribute("data-pn") !== pn) return;   // 그 사이 창을 닫거나 다른 부품을 엶
        if (res.status !== "done") { b.innerHTML = '<p class="rdc-err">조회 실패: ' + esc(res.error || "") + '</p><button class="btn-secondary" id="aNowBtn">다시 조회</button>'; return; }
        var r = res.result, p = state.parts[pn];
        if (p && r.found) {   // 받은 김에 현재고도 갱신
          if (p.lct_cd !== r.lct_cd) { locRemove(p.lct_cd, pn); locAdd(r.lct_cd, pn); }
          p.crt_qty = r.crt_qty; p.lct_cd = r.lct_cd;
        }
        b.innerHTML = auditNowHtml(findAuditItem(pn), r.found ? Number(r.crt_qty) : 0, r.lct_cd, '지금 DMS', hhmm(new Date().toISOString()) + ' 조회');
        if (state.tab === "audit") render(false);   // 목록의 '조사 시작 뒤' 표시도 새 값으로
      });
    } catch (e) {
      btn.disabled = false; btn.textContent = "↻ 지금 DMS에서 다시 조회";
      toast("조회하지 못했습니다: " + e.message);
    }
  }
  function auditNowHtml(it, bmwNow, lctNow, label, when) {
    var rrNow = itemRrKnown(it) ? rrQty(it.item_cd) : 0, totNow = bmwNow + rrNow, d = totNow - itemTotal(it);
    var msg = !d ? '<div class="nowbox-msg ok">' + sinceLabel() + ' 바뀌지 않았습니다</div>'
      : '<div class="nowbox-msg warn">' + sinceLabel() + ' <b>' + qtyNum(Math.abs(d)) + '개 ' + (d < 0 ? '줄었습니다' : '늘었습니다') + '</b> (' + (d < 0 ? '출고' : '입고') + ' 등)</div>' +
        '<button class="btn-inline" id="aUseNow" data-qty="' + qtyNum(totNow) + '" data-d="' + qtyNum(d) + '">지금 수량 ' + qtyNum(totNow) + '개로 실사 입력 ›</button>';
    return '<div class="nowbox-row"><span>' + label + '</span><b>' + qtyNum(totNow) + '</b><small>EA</small></div>' +
      '<div class="nowbox-sub">BMW ' + qtyNum(bmwNow) + ' · RR ' + qtyNum(rrNow) + (lctNow && lctNow !== it.lct_cd ? ' · 위치 ' + esc(lctNow) : '') + ' · ' + when + '</div>' + msg +
      '<button class="btn-inline nowbox-again" id="aNowBtn">↻ 지금 DMS에서 다시 조회</button>';
  }

  async function markAudit(pn, status, counted, memo) {
    delete lastAudits[pn];   // 부품 화면의 '마지막 재고조사'를 새로 받게
    var a = currentAudit(), it = findAuditItem(pn);
    var pf = proofOf(it);
    if (!pf) { toast("위치를 먼저 스캔하세요"); openAuditItem(pn); return; }
    var job = { userId: state.user.id, auditId: a.id, kind: a.kind, pn: pn, status: status, counted: counted, memo: memo || null, tries: 0,
      proof: { loc_via: pf.via, loc_scanned_at: pf.at, marked_at: new Date().toISOString(), exempt_reason: pf.reason || null } };
    delete sheetExempt[pn];
    var res = await sendAuditMark(job);
    if (res === "net") {
      queueAuditMark(job);
      toast("연결이 불안정해 휴대폰에 저장했습니다. 연결되면 자동으로 보냅니다");
    } else if (res !== "ok" && res !== "check") {
      await loadAudits();
      if (currentAudit() && currentAudit().finished_at) { closeSheet(); render(false); toast("이미 종료된 조사라 저장하지 못했습니다"); return; }
      toast(res); return;
    }
    auditCounts[a.id] = auditStatsOf(state.auditItems);
    closeSheet(); render(false);
    if (res === "check") toast("조사 결과는 저장했지만 체크 기록에 반영하지 못했습니다. 다시 저장해 주세요");
  }

  // 전파가 약한 곳: 보내지 못한 재고조사 확인을 이 휴대폰에 두었다가 연결되면 다시 보냄
  var outbox = store.get("auditOutbox", []), flushing = false;
  function isNetErr(r) { return !navigator.onLine || !r.status; }
  // 결과: "ok" | "check"(항목은 저장, 체크 기록 실패) | "net"(연결 문제) | 오류 문구
  async function sendAuditMark(job) {
    var r = await sb.from("inv_audit_items").update(Object.assign({ status: job.status, counted: job.counted, memo: job.memo }, job.proof || {}))
      .eq("audit_id", job.auditId).eq("item_cd", job.pn).select().single();
    if (r.error) return isNetErr(r) ? "net" : "저장하지 못했습니다: " + r.error.message;
    var it = state.auditItems.length && currentAudit() && currentAudit().id === job.auditId ? findAuditItem(job.pn) : null;
    if (it) { Object.assign(it, r.data); delete it.pending; }
    return (await syncAuditCheck({ id: job.auditId, kind: job.kind }, r.data, job.status, job.counted, job.memo)) ? "ok" : "check";
  }
  function queueAuditMark(job) {
    outbox = outbox.filter(function (j) { return !(j.auditId === job.auditId && j.pn === job.pn); }).concat([job]);
    store.set("auditOutbox", outbox);
    applyOutbox(job.auditId);
  }
  // 아직 보내지 못한 확인을 화면 목록에 덮어 보여줌
  function applyOutbox(auditId) {
    outbox.forEach(function (j) {
      if (j.auditId !== auditId) return;
      var it = findAuditItem(j.pn);
      if (it) Object.assign(it, j.proof || {}, { status: j.status, counted: j.counted, memo: j.memo, pending: true, checked_by_name: state.user.name, checked_at: new Date().toISOString() });
    });
  }
  async function flushOutbox() {
    if (flushing || !state.user || !navigator.onLine) return;
    var mine = outbox.filter(function (j) { return j.userId === state.user.id; });
    if (!mine.length) return;
    flushing = true;
    var sent = 0, dropped = [];
    try {
      for (var i = 0; i < mine.length; i++) {
        var job = mine[i], res = await sendAuditMark(job);
        if (res === "net") break;
        if (res !== "ok" && ++job.tries < 5) { store.set("auditOutbox", outbox); continue; }   // 다음에 다시
        outbox = outbox.filter(function (j) { return j !== job; });
        store.set("auditOutbox", outbox);
        if (res === "ok") sent++; else dropped.push(job.pn);
      }
    } finally { flushing = false; }
    if (sent) {
      var a = currentAudit();
      if (a) auditCounts[a.id] = auditStatsOf(state.auditItems);
      toast("휴대폰에 두었던 조사 결과 " + sent + "건을 보냈습니다");
    }
    if (dropped.length) toast("조사 결과를 보내지 못했습니다: " + dropped.join(", ") + " — 다시 확인해 주세요");
    if (sent || dropped.length) { if ($("sheet").hidden) render(false); }
  }
  window.addEventListener("online", flushOutbox);
  // 조사 항목 하나에 열린 체크 기록은 하나만: 수량 다름이면 새로 쓰거나 고치고, 일치로 바꾸면 지움
  async function syncAuditCheck(a, it, status, counted, memo) {
    var ex = await sb.from("inv_checks").select("id").eq("audit_id", a.id).eq("item_cd", it.item_cd).is("cleared_at", null).order("id");
    if (ex.error) return false;
    var ids = ex.data.map(function (x) { return x.id; });
    var keep = status === "diff" ? ids[0] : null;
    var stale = ids.filter(function (id) { return id !== keep; });
    var now = new Date().toISOString(), w;
    if (stale.length) {
      w = await sb.from("inv_checks").update({ cleared_at: now }).in("id", stale);
      if (w.error) return false;
    }
    if (status === "diff") {
      var row = { counted_qty: counted, rr_qty: itemRr(it), memo: memo || (AUDIT_TITLE[a.kind] + " 중 확인") };
      w = keep
        ? await sb.from("inv_checks").update(row).eq("id", keep)
        : await sb.from("inv_checks").insert(Object.assign(row, { item_cd: it.item_cd, item_nm: it.item_nm, lct_cd: it.lct_cd, dms_qty: it.qty, audit_id: a.id, checked_by: state.user.id }));
      if (w.error) return false;
    }
    if (stale.length || status === "diff") await loadChecks();
    return true;
  }

  // ---------- 재고조사 종료·보고서 (PDF: report.js) ----------
  function openFinish() {
    var a = currentAudit(), st = auditStatsOf(state.auditItems);
    var wait = outbox.filter(function (j) { return j.auditId === a.id; }).length;
    openSheet(
      '<div class="sheet-head"><button class="cancel" data-close>취소</button><h2>조사 종료</h2><span></span></div>' +
      '<div class="summary"><div><b>' + st.done + '</b><span>확인</span></div><div class="' + (st.diff ? "w" : "") + '"><b>' + st.diff + '</b><span>수량 다름</span></div><div class="' + (st.left ? "w" : "") + '"><b>' + st.left + '</b><span>미확인</span></div></div>' +
      (st.left ? '<p class="sheet-sub warn-text">확인하지 않은 부품 ' + st.left + '건은 보고서에 "미확인"으로 남습니다.</p>' : '') +
      (wait ? '<div class="notice">휴대폰에 두고 아직 보내지 못한 확인이 ' + wait + '건 있습니다. 연결되어 다 보낸 뒤 종료하세요.</div>' : '') +
      '<p class="footnote">종료하면 이 조사는 더 이상 고칠 수 없고, 보고서를 PDF로 저장해 OneDrive 로 보낼 수 있습니다.</p>' +
      '<button class="btn-primary" id="auditFinishOk"' + (wait ? ' disabled' : '') + '>종료하고 보고서 만들기</button>'
    );
  }
  async function finishAudit(btn) {
    btn.disabled = true;
    var r = await sb.rpc("inv_finish_audit", { p_id: currentAudit().id });
    if (r.error) { toast("종료하지 못했습니다: " + r.error.message); btn.disabled = false; return; }
    await loadAudits();
    closeSheet(); render(false);
    openReport();
  }

  // 잘못 종료했을 때: 종료 표시만 지우고 확인한 내용 그대로 이어서
  function openReopen() {
    var a = currentAudit(), st = auditStatsOf(state.auditItems);
    openSheet(
      '<div class="sheet-head"><button class="cancel" data-close>취소</button><h2>다시 시작</h2><span></span></div>' +
      '<p class="sheet-sub">' + hhmm(a.finished_at) + ' ' + esc(a.finished_by_name || "") + '이(가) 종료한 조사를 다시 엽니다.</p>' +
      '<div class="summary"><div><b>' + st.done + '</b><span>확인</span></div><div class="' + (st.left ? "w" : "") + '"><b>' + st.left + '</b><span>남은 것</span></div></div>' +
      '<p class="footnote">지금까지 확인한 ' + st.done + '건은 그대로 두고, 남은 ' + st.left + '건부터 이어서 확인합니다. 다 마치면 다시 "조사 종료"를 눌러 보고서를 만드세요.</p>' +
      '<button class="btn-primary" id="auditReopenOk">다시 시작</button>'
    );
  }
  // 남은(확인 안 한) 부품만 최근 DMS 현재고(BMW·RR)로 수량·위치를 바꿈. 확인한 부품은 그대로 (inv_refresh_audit)
  async function refreshAudit(btn) {
    var a = currentAudit();
    if (!a || btn.classList.contains("busy")) return;
    btn.classList.add("busy"); btn.disabled = true;
    var r = await sb.rpc("inv_refresh_audit", { p_id: a.id });
    if (r.error) { toast("갱신하지 못했습니다: " + r.error.message); btn.classList.remove("busy"); btn.disabled = false; return; }
    try {
      await loadAudits();
      await loadAuditItems(a.id);
      auditCounts[a.id] = auditStatsOf(state.auditItems);
    } catch (e) { toast("목록을 다시 불러오지 못했습니다: " + e.message); }
    render(false);
    var na = currentAudit(), at = na && na.qty_basis_at ? hhmm(na.qty_basis_at) : basis();
    var res = r.data || {}, ch = Number(res.changed) || 0, rm = Number(res.removed) || 0;
    toast(ch || rm ? at + " DMS 기준 · " + [ch ? "수량·위치 " + ch + "건 바꿈" : "", rm ? "재고 0인 " + rm + "건 뺌" : ""].filter(Boolean).join(" · ")
      : "남은 부품 수량·위치가 " + at + " DMS와 같습니다");
  }

  async function reopenAudit(btn) {
    btn.disabled = true;
    var r = await sb.rpc("inv_reopen_audit", { p_id: currentAudit().id });
    if (r.error) { toast("다시 열지 못했습니다: " + r.error.message); btn.disabled = false; return; }
    await loadAudits();
    state.auditFilter = "left"; state.auditLoc = null;
    closeSheet(); render(true);
    toast("조사를 다시 열었습니다. 남은 것부터 이어서 확인하세요");
  }

  // 현장 확인 점검: 예외 / 스캔하고 오래 지나 확인 / 같은 사람이 너무 빠르게 연달아 확인 / 기록 없음
  var PROOF_GAP_MIN = 30, PROOF_QUICK_SEC = 3;
  var VIA_LABEL = { scanner: "위치 스캔", camera: "위치 스캔(카메라)", part: "부품 스캔", exempt: "예외" };
  function proofReport(items) {
    var done = items.filter(function (it) { return it.status; });
    var used = done.some(function (it) { return it.loc_via; });   // 이 기능 전에 확인한 조사는 점검 안 함
    var sum = { scanner: 0, camera: 0, part: 0, exempt: 0, none: 0 };
    var flags = {};
    var add = function (it, msg) { (flags[it.item_cd] = flags[it.item_cd] || { it: it, notes: [] }).notes.push(msg); };
    done.forEach(function (it) {
      sum[it.loc_via || "none"]++;
      if (it.loc_via === "exempt") add(it, "예외: " + (it.exempt_reason || ""));
      else if (!it.loc_via) { if (used) add(it, "스캔 기록 없음"); }
      else if (it.loc_scanned_at && it.marked_at) {
        var gap = (new Date(it.marked_at) - new Date(it.loc_scanned_at)) / 60000;
        if (gap > PROOF_GAP_MIN) add(it, "스캔 " + (gap >= 120 ? Math.round(gap / 60) + "시간" : Math.round(gap) + "분") + " 뒤 확인");
      }
    });
    // 사람별로 누른 순서대로: 앞 확인과 몇 초 차이인지
    var byWho = {};
    done.forEach(function (it) { if (it.marked_at) (byWho[it.checked_by_name || ""] = byWho[it.checked_by_name || ""] || []).push(it); });
    Object.keys(byWho).forEach(function (w) {
      var l = byWho[w].sort(function (x, y) { return x.marked_at.localeCompare(y.marked_at); });
      for (var i = 1; i < l.length; i++) {
        var sec = (new Date(l[i].marked_at) - new Date(l[i - 1].marked_at)) / 1000;
        if (sec < PROOF_QUICK_SEC) add(l[i], "앞 확인 " + Math.max(0, Math.round(sec * 10) / 10) + "초 뒤 (빠른 확인)");
      }
    });
    return {
      summary: used ? sum : null,
      items: Object.keys(flags).map(function (k) { var f = flags[k], it = f.it; return { lct_cd: it.lct_cd, item_cd: it.item_cd, item_nm: it.item_nm, result: it.status === "ok" ? "일치" : "수량 다름", by: it.checked_by_name, note: f.notes.join(" · ") }; })
        .sort(function (x, y) { return (x.lct_cd || "~").localeCompare(y.lct_cd || "~") || x.item_cd.localeCompare(y.item_cd); })
    };
  }

  var REPORT_TITLE = { daily: "일일 재고조사 보고서", aging: "일일장기 재고조사 보고서", weekly: "주간 재고조사 보고서" };
  function reportData(a, items) {
    var diff = items.filter(function (it) { return it.status === "diff"; }), left = items.filter(function (it) { return !it.status; });
    return {
      title: REPORT_TITLE[a.kind], branch: state.user.branch + " 부품창고", period: periodLabel(a.kind, a),
      started_at: a.started_at, started_by: a.started_by_name, finished_at: a.finished_at, finished_by: a.finished_by_name, printed_at: new Date(),
      total: items.length, ok: items.length - diff.length - left.length, diff: diff.length, left: left.length,
      diffItems: diff.map(function (it) { return { lct_cd: it.lct_cd, item_cd: it.item_cd, item_nm: it.item_nm + (it.carry_from ? " (" + carryLabel(it) + ")" : ""), qty: it.qty, rr: itemRr(it), counted: it.counted, by: it.checked_by_name, memo: it.memo }; }),
      leftItems: left.map(function (it) { return { lct_cd: it.lct_cd, item_cd: it.item_cd, item_nm: it.item_nm + (it.carry_from ? " (" + carryLabel(it) + ")" : ""), qty: it.qty, rr: itemRr(it) }; }),
      removedItems: (a.qty_removed || []).map(function (x) { return { lct_cd: x.lct_cd, item_cd: x.item_cd, item_nm: x.item_nm, qty: x.qty, rr: x.rr_qty, at: x.removed_at, by: x.removed_by }; }),
      proof: proofReport(items)
    };
  }
  // 파일 이름: "261007 일일 재고조사 보고서", "260928-1003 주간 재고조사 보고서"
  function reportFileName(a) {
    var d = function (x) { return x.slice(2).replace(/-/g, ""); };
    return d(a.period_start) + (a.kind === "weekly" ? "-" + d(a.period_end).slice(2) : "") + " " + REPORT_TITLE[a.kind];
  }

  var report = null;   // 미리보기 중인 보고서 {file, error, name}
  function openReport() {
    var a = currentAudit();
    if (!a || !window.AuditReport) return;
    var pages = AuditReport.pages(reportData(a, state.auditItems));
    report = { file: null, error: "", name: reportFileName(a) };
    var el = document.createElement("div");
    el.id = "reportView"; el.className = "reportview";
    el.innerHTML = '<div class="rv-bar"><button class="rv-close" id="rvClose">닫기</button><b>보고서 미리보기</b><span class="rv-n">' + pages.length + '쪽</span></div>' +
      '<div class="rv-scroll" id="rvScroll"><div class="rv-pages" id="rvPages">' + pages.join("") + '</div></div>' +
      '<div class="rv-panel">' +
        '<div class="rv-name"><input id="rvName" value="' + esc(report.name) + '" aria-label="파일 이름" autocomplete="off"><span>.pdf</span></div>' +
        '<p class="rv-state" id="rvState">PDF 만드는 중…</p>' +
        '<div id="rvRetry" hidden><p class="rv-state err" id="rvErr"></p><button class="btn-primary" id="rvShare2" style="margin-top:8px">📤 다시 보내기</button>' +
          '<a class="btn-primary rv-chrome" id="rvChrome" href="' + esc(chromeUrl()) + '" hidden>크롬에서 열기</a></div>' +
        '<button class="btn-primary" id="rvShare" style="margin-top:8px">OneDrive 에 PDF 저장</button>' +
        '<button class="btn-ghost" id="rvDownload">기기에 내려받기</button>' +
        '<p class="footnote">공유 메뉴에서 OneDrive 를 고른 뒤 저장할 폴더를 고르세요.</p>' +
      '</div>';
    $("app").appendChild(el);
    var fit = function () { if ($("rvPages")) $("rvPages").style.zoom = Math.min(1, ($("rvScroll").clientWidth - 24) / (210 * 96 / 25.4)); };
    fit(); window.addEventListener("resize", fit);
    report.unfit = function () { window.removeEventListener("resize", fit); };
    // 공유 메뉴는 버튼을 누른 직후에만 열리므로 PDF 를 미리 만들어 둔다
    var mine = report;
    setTimeout(function () {
      AuditReport.buildPdf(pages, mine.name, function (n, total) { if (report === mine) $("rvState").textContent = "PDF 만드는 중… " + n + "/" + total + "쪽"; })
        .then(function (f) { mine.file = f; if (report === mine) $("rvState").textContent = "PDF 준비됨 · " + (f.size / 1024 / 1024).toFixed(1) + "MB"; })
        .catch(function (e) { mine.error = e.message; if (report === mine) { $("rvState").textContent = "PDF 를 만들지 못했습니다: " + e.message; $("rvState").classList.add("err"); } });
    }, 400);
  }
  function closeReport() {
    if (report && report.unfit) report.unfit();
    report = null;
    if ($("reportView")) $("reportView").remove();
  }
  // 미리 만든 PDF 에 지금 입력한 이름을 붙인다
  function namedReport() {
    var n = ($("rvName").value || "").replace(/[\\/:*?"<>|]/g, " ").replace(/\.pdf$/i, "").replace(/\s+/g, " ").trim() || report.name;
    return new File([report.file], n + ".pdf", { type: "application/pdf" });
  }
  async function shareReport() {
    if (!report.file) { toast(report.error ? "PDF 를 만들지 못했습니다: " + report.error : "PDF 를 만드는 중입니다. 다 되면 한 번 더 눌러 주세요"); return; }
    var r = await AuditReport.shareFile(namedReport());
    if (r.status === "shared") { toast("보냈습니다"); shareRetry(false); }
    else if (r.status === "unsupported") toast("이 브라우저는 파일 공유를 지원하지 않습니다 — '기기에 내려받기'를 쓰세요");
    else if (r.status === "blocked") shareRetry(true, r.error);
    // cancelled: 공유 메뉴를 닫음 — 그대로 두어 다시 고를 수 있게
  }
  // 공유가 거절되면 큰 "다시 보내기" 버튼을 보여 줌 (새로 누른 순간에는 대부분 열림). 오류는 원인 확인용으로 작게 표시
  function shareRetry(on, err) {
    if (!$("rvRetry")) return;
    $("rvRetry").hidden = !on;
    if (!on) return;
    // 삼성 인터넷은 PDF 파일 공유를 막음 (NotAllowedError: Permission denied) → 다시 눌러도 안 되므로 크롬으로 안내
    var samsung = isSamsung();
    $("rvErr").textContent = samsung
      ? "삼성 인터넷은 PDF 파일 공유를 막고 있습니다. 크롬에서 앱을 열어 저장하거나, 내려받은 뒤 OneDrive 앱에서 올려 주세요. (" + err + ")"
      : "공유 메뉴가 열리지 않았습니다. 아래 버튼을 한 번 더 눌러 주세요." + (err ? " (" + err + " · " + browserName() + ")" : "");
    $("rvShare2").hidden = samsung;
    $("rvChrome").hidden = !samsung;
  }
  function isSamsung() { return /SamsungBrowser/.test(navigator.userAgent); }
  // 같은 주소를 크롬으로 엶 (안드로이드 intent 주소. 크롬이 없으면 그냥 이 주소를 엶)
  function chromeUrl() {
    return "intent://" + location.host + location.pathname + "#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=" + encodeURIComponent(location.href) + ";end";
  }
  function browserName() {
    var u = navigator.userAgent;
    return /SamsungBrowser/.test(u) ? "삼성 인터넷" : /KAKAOTALK/i.test(u) ? "카카오톡" : /NAVER/.test(u) ? "네이버" : /EdgA/.test(u) ? "엣지" : /Chrome/.test(u) ? "크롬" : /Safari/.test(u) ? "사파리" : "기타";
  }

  var auditChannel = null;
  async function openAudit(kind) {
    state.auditOpen = kind; state.auditLoc = null; state.auditFilter = "left"; state.auditItems = [];
    var a = currentAudit();
    if (a) {
      view('<div class="loading">목록을 불러오는 중…</div>');
      await loadAuditItems(a.id);
      auditCounts[a.id] = auditStatsOf(state.auditItems);
      subscribeAudit(a.id);
    }
    render(true);
  }
  // 다른 직원이 같은 조사를 확인하면 바로 반영
  function subscribeAudit(id) {
    if (auditChannel) { sb.removeChannel(auditChannel); auditChannel = null; }
    auditChannel = sb.channel("audit-" + id)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "inv_audit_items", filter: "audit_id=eq." + id }, function (p) {
        var it = findAuditItem(p.new.item_cd);
        if (!it) return;
        Object.assign(it, p.new);
        auditCounts[id] = auditStatsOf(state.auditItems);
        if (state.tab === "audit" && $("sheet").hidden) render(false);
      })
      // DMS 갱신으로 재고 0인 부품이 빠지면 (삭제 알림은 거를 수 없어 조사 번호로 확인)
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "inv_audit_items" }, function (p) {
        var o = p.old || {};
        if (o.audit_id !== id) return;
        var before = state.auditItems.length;
        state.auditItems = state.auditItems.filter(function (x) { return x.item_cd !== o.item_cd; });
        if (state.auditItems.length === before) return;
        auditCounts[id] = auditStatsOf(state.auditItems);
        if (state.tab === "audit" && $("sheet").hidden) render(false);
      })
      .subscribe();
  }

  // ---------- 다른 탭 ----------
  function viewRecent() {
    var rows = state.recent.map(function (r) {
      var loc = isLoc(r.code), part = state.parts[r.code];
      if (!loc && !part) return "";
      var title = loc ? '<span class="row-title mono-loc">' + esc(r.code) + '</span>' : '<span class="pn">' + esc(r.code) + '</span>';
      var sub = loc ? "부품 " + partsAt(r.code).length + "종" : part.item_nm;
      return '<button class="row" data-open="' + esc(r.code) + '"><span class="tag ' + (loc ? "loc" : "") + '">' + (loc ? "위치" : "부품") + '</span><div class="row-main">' + title + '<div class="row-sub">' + esc(sub) + '</div></div><span class="row-value" style="font-size:var(--fs-sm)">' + r.time + '</span>' + CHEV + '</button>';
    }).join("");
    return '<h1 class="large">최근 스캔</h1><p class="meta">이 휴대폰에서 스캔한 ' + state.recent.length + '건</p>' +
      (rows ? '<div class="group">' + rows + '</div><p class="footnote">누르면 스캔 화면에서 다시 조회합니다.</p>' : '<div class="empty">아직 스캔한 바코드가 없습니다</div>');
  }

  function viewLog() {
    var head = '<h1 class="large">체크 기록</h1><p class="meta">수량이 다른 부품 ' + state.checks.length + '건</p>';
    if (!state.checks.length) return head + '<div class="empty">아직 체크한 부품이 없습니다.<br>위치를 스캔하고 수량이 다른 부품의 동그라미를 누르세요.</div>';
    var html = "", day = null;
    state.checks.forEach(function (c) {
      var d = new Date(c.checked_at), key = (d.getMonth() + 1) + "월 " + d.getDate() + "일";
      if (key !== day) { if (day !== null) html += '</div>'; day = key; html += '<div class="section-label">' + key + '</div><div class="group">'; }
      var diff = c.counted_qty - checkBase(c);
      html += '<button class="row" data-logitem="' + c.id + '"><div class="row-main"><div class="pn">' + esc(c.item_cd) + '</div><div class="row-sub">' + esc(c.item_nm) + '</div><div class="row-sub">' + esc(c.lct_cd || "-") + ' · ' + hhmm(c.checked_at) + ' · ' + esc(c.checked_by_name || "") + (c.memo ? ' · ' + esc(c.memo) : '') + '</div>' + splitNote(c.dms_qty, Number(c.rr_qty) || 0) + '</div>' +
        '<div class="diff"><b>' + qtyNum(checkBase(c)) + ' → ' + qtyNum(c.counted_qty) + '</b><span class="tag warn">' + (diff > 0 ? "+" : "−") + Math.abs(qtyNum(diff)) + '</span></div></button>';
    });
    return head +
      '<div style="margin-bottom:6px"><button class="btn-secondary" id="exportBtn">엑셀로 내보내기</button></div>' + html + '</div>' +
      '<p class="footnote">DMS 수량은 체크한 시점의 값입니다. 재고를 정정한 뒤 기록을 지우면 목록에서 사라집니다.</p>';
  }

  // ---------- 위치 변경 이력 (앱에서 요청한 위치 변경) ----------
  var MOVE_PILL = { done: ["ok", "완료"], failed: ["warn", "실패"], cancelled: ["", "취소"], running: ["run", "처리 중"], pending: ["run", "대기"] };
  async function loadMoveLog() {
    var r = await sb.from("inv_requests").select("id,item_cd,params,status,result,error,requested_by_name,requested_at,finished_at")
      .eq("kind", "loc_change").order("requested_at", { ascending: false }).limit(300);
    state.moveLog = r.error ? { error: r.error.message } : { rows: r.data };
  }
  function openMoveLog(back, q) {
    state.movesBack = back; state.moveQ = q || ""; state.moveFilter = "all";
    state.tab = "moves"; render(true);
    loadMoveLog().then(function () { if (state.tab === "moves") render(false); });
  }
  function moveRoute(m) {
    var r = m.status === "done" && m.result ? m.result : m.params || {};
    return { from: r.from || "", to: r.to || "", unchanged: !!(m.result && m.result.unchanged) };
  }
  function moveRows() {
    var log = state.moveLog;
    if (!log) return '<div class="loading">이력을 불러오는 중…</div>';
    if (log.error) return '<div class="empty">이력을 불러오지 못했습니다<br>' + esc(log.error) + '</div>';
    var q = normCode(state.moveQ);
    var list = log.rows.filter(function (m) {
      if (state.moveFilter === "done" && m.status !== "done") return false;
      if (state.moveFilter === "problem" && m.status !== "failed" && m.status !== "cancelled") return false;
      if (!q) return true;
      var rt = moveRoute(m), p = state.parts[m.item_cd];
      return m.item_cd.indexOf(q) >= 0 || rt.from.indexOf(q) >= 0 || rt.to.indexOf(q) >= 0 ||
        (p && String(p.item_nm || "").toUpperCase().replace(/\s+/g, "").indexOf(q) >= 0);
    });
    if (!list.length) return '<div class="empty">' + (q || state.moveFilter !== "all" ? "조건에 맞는 이력이 없습니다" : "아직 앱에서 위치를 바꾼 기록이 없습니다") + '</div>';
    var html = "", day = null;
    list.forEach(function (m) {
      var d = new Date(m.requested_at), key = (d.getMonth() + 1) + "월 " + d.getDate() + "일";
      if (key !== day) { if (day !== null) html += '</div>'; day = key; html += '<div class="section-label">' + key + '</div><div class="group">'; }
      var rt = moveRoute(m), p = state.parts[m.item_cd];
      var pill = rt.unchanged ? ["", "변경 없음"] : MOVE_PILL[m.status] || ["", m.status];
      var inner = '<div class="row-main"><div class="pn">' + esc(m.item_cd) + '</div>' +
        (p ? '<div class="row-sub">' + esc(p.item_nm) + '</div>' : '') +
        '<div class="row-sub">' + hhmm(m.requested_at) + ' · ' + esc(m.requested_by_name || "") + '</div>' +
        (m.error ? '<div class="row-sub' + (m.status === "failed" ? ' warn-text' : '') + '" style="white-space:normal">' + esc(m.error) + '</div>' : '') + '</div>' +
        '<div class="diff"><b class="mono-loc">' + esc(rt.from || "공란") + ' → ' + esc(rt.to) + '</b><span class="pill ' + pill[0] + '">' + pill[1] + '</span></div>';
      html += p ? '<button class="row" data-open="' + esc(m.item_cd) + '">' + inner + '</button>' : '<div class="row">' + inner + '</div>';
    });
    return html + '</div>';
  }
  function viewMoves() {
    var rows = state.moveLog && state.moveLog.rows || [];
    var n = { all: rows.length, done: 0, problem: 0 };
    rows.forEach(function (m) { if (m.status === "done") n.done++; else if (m.status === "failed" || m.status === "cancelled") n.problem++; });
    return '<button class="rback" id="movesBack">' + BACK + (state.movesBack === "scan" ? "부품" : "설정") + '</button>' +
      '<h1 class="large">위치 변경 이력</h1><p class="meta">이 앱에서 요청한 위치 변경 · 최근 300건</p>' +
      '<div class="search" style="margin-top:0">' + SEARCH + '<input id="moveSearch" value="' + esc(state.moveQ) + '" placeholder="품번·품명·위치로 찾기" aria-label="이력에서 찾기" autocapitalize="characters"></div>' +
      '<div class="seg" role="tablist">' +
        '<button data-mfilter="all" class="' + (state.moveFilter === "all" ? "on" : "") + '">전체 ' + n.all + '</button>' +
        '<button data-mfilter="done" class="' + (state.moveFilter === "done" ? "on" : "") + '">완료 ' + n.done + '</button>' +
        '<button data-mfilter="problem" class="' + (state.moveFilter === "problem" ? "on" : "") + '">실패·취소 ' + n.problem + '</button>' +
      '</div>' +
      '<div id="moveList">' + moveRows() + '</div>' +
      '<p class="footnote">DMS 화면에서 직접 바꾼 위치는 나오지 않습니다. 누르면 그 부품을 스캔 화면에서 엽니다.</p>';
  }

  function viewSettings() {
    var s = state.status || {};
    return '<h1 class="large">설정</h1><p class="meta">AS_부산(해운중동) · ' + esc(state.user.branch) + '</p>' +
      '<div class="section-label" style="margin-top:0">계정</div>' +
      '<div class="group">' +
        '<div class="row"><div class="row-main">이름</div><span class="row-value">' + esc(state.user.name) + '</span></div>' +
        '<div class="row"><div class="row-main">아이디</div><span class="row-value">' + esc(state.user.login_id) + '</span></div>' +
      '</div>' +
      '<p class="footnote">태블릿 입출고 앱과 같은 계정입니다. 비밀번호 변경은 태블릿 앱에서 합니다.</p>' +
      '<div class="section-label">스캔</div>' +
      '<div class="group">' +
        '<div class="row"><div class="row-main">카메라 스캔</div><label class="switch"><input type="checkbox" id="optCam"' + (store.get("camera", true) ? " checked" : "") + ' aria-label="카메라 스캔"><i></i></label></div>' +
        '<div class="row"><div class="row-main">카메라 인식 방식</div><span class="row-value">' + esc(cam.engine || "준비 전") + '</span></div>' +
        '<div class="row"><div class="row-main">스캔 성공 시 소리·진동</div><label class="switch"><input type="checkbox" id="optSound"' + (store.get("sound", true) ? " checked" : "") + ' aria-label="스캔 성공 시 소리"><i></i></label></div>' +
        '<div class="row"><div class="row-main">인식 진단 모드</div><label class="switch"><input type="checkbox" id="optDiag"' + (store.get("diag", false) ? " checked" : "") + ' aria-label="인식 진단 모드"><i></i></label></div>' +
      '</div>' +
      '<p class="footnote">블루투스 스캐너는 휴대폰에 키보드로 연결하면 바로 쓸 수 있습니다. 진단 모드를 켜면 카메라에 "진단" 버튼이 생기고, 누른 순간의 장면이 인식 개선용으로 저장됩니다.</p>' +
      '<div class="section-label">데이터</div>' +
      '<div class="group">' +
        '<div class="row"><div class="row-main">현재고 기준 시각</div><span class="row-value">' + basis() + '</span></div>' +
        '<div class="row"><div class="row-main">부품창고 품목</div><span class="row-value">' + Object.keys(state.parts).length.toLocaleString() + '건</span></div>' +
        '<div class="row"><div class="row-main">DMS 연결 PC</div><span class="row-value">' + (daemonStale() ? '<span style="color:var(--danger)">응답 없음</span>' : '<span class="dot" style="display:inline-block;margin-right:6px"></span>연결됨 · ' + hhmm(s.daemon_seen_at)) + '</span></div>' +
        '<div class="row"><div class="row-main">RR 현재고 기준 시각</div><span class="row-value">' + (rrBasis() || "-") + ' · ' + Object.keys(state.rrParts).length.toLocaleString() + '건</span></div>' +
        (rrProblem() ? '<div class="row"><div class="row-main">RR 현재고 문제</div></div><p class="footnote" style="color:var(--danger);margin:0;padding:0 16px 12px">' + esc(rrProblem()) + '</p>' : '') +
        '<div class="row"><div class="row-main">제외</div><span class="row-value">Z 서비스 코드</span></div>' +
      '</div>' +
      '<div class="section-label">기록</div>' +
      '<div class="group"><button class="row" id="movesOpen"><div class="row-main row-link">위치 변경 이력</div>' + CHEV + '</button></div>' +
      '<div class="section-label"></div>' +
      '<div class="group"><button class="row" id="logoutBtn"><div class="row-main row-danger">로그아웃</div></button></div>';
  }

  function viewLogin() {
    return '<form class="login" id="loginForm" autocomplete="on">' +
      '<h1>DS재고 관리</h1><p class="meta">해운대 부품창고 · 태블릿 입출고 앱과 같은 아이디로 로그인하세요</p>' +
      '<div class="group">' +
        '<div class="row"><label for="loginId">아이디</label><input id="loginId" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>' +
        '<div class="row"><label for="loginPw">비밀번호</label><input id="loginPw" name="password" type="password" autocomplete="current-password" required></div>' +
      '</div>' +
      '<p class="login-error" id="loginError"></p>' +
      '<button class="btn-primary" type="submit" id="loginBtn">로그인</button>' +
    '</form>';
  }

  // ---------- 렌더 ----------
  function view(html) { $("view").innerHTML = html; }
  function showScanner(on) {
    var host = $("scannerHost");
    if (on && host.hidden) { host.hidden = false; renderScanner(); }
    else if (!on && !host.hidden) { host.hidden = true; host.innerHTML = ""; stopCamera(); }
  }

  function render(resetScroll) {
    try { renderView(resetScroll); } finally { renderMoveBar(); }
  }
  function renderView(resetScroll) {
    var nav = $("nav"), content = $("content");
    if (!state.user) {
      showScanner(false); $("tabbar").hidden = true; nav.innerHTML = "";
      if (!$("loginForm")) view(viewLogin());
      return;
    }
    $("tabbar").hidden = false;
    if (state.loading) { showScanner(false); view('<div class="loading">재고를 불러오는 중…</div>'); return; }

    var html;
    if (state.tab === "log") html = viewLog();
    else if (state.tab === "recent") html = viewRecent();
    else if (state.tab === "settings") html = viewSettings();
    else if (state.tab === "moves") html = viewMoves();
    else if (state.tab === "audit") html = viewAudit();
    else html = viewScan();

    var withScanner = state.tab === "scan" || (state.tab === "audit" && state.auditOpen && !!currentAudit() && !currentAudit().finished_at);
    showScanner(withScanner);
    if ($("daemonNotice")) $("daemonNotice").innerHTML = daemonNotice();

    if (state.tab === "scan") {
      nav.innerHTML = '<span></span><span class="nav-title always">스캔</span><span class="nav-meta">' + basis() + ' 기준</span>';
    } else if (state.tab === "audit" && state.auditOpen) {
      nav.innerHTML = '<span></span><span class="nav-title always">' + AUDIT_TITLE[state.auditOpen] + '</span><span class="nav-meta">' + basis() + ' 기준</span>';
    } else {
      nav.innerHTML = '<span></span><span class="nav-title">' + ({ log: "체크 기록", recent: "최근 스캔", settings: "설정", audit: "재고조사", moves: "위치 변경 이력" }[state.tab]) + '</span><span></span>';
    }

    var top = content.scrollTop;
    var ae = document.activeElement, focusId = !resetScroll && ae && ae.id && $("view").contains(ae) && /^(INPUT|TEXTAREA)$/.test(ae.tagName) ? ae.id : null;
    var caret = focusId ? [ae.selectionStart, ae.selectionEnd] : null;
    view(html);
    content.scrollTop = resetScroll ? 0 : top;
    if (focusId && $(focusId)) {
      var fe = $(focusId);
      fe.focus({ preventScroll: true });
      try { fe.setSelectionRange(caret[0], caret[1]); } catch (e) { /* 커서 지정 못하는 칸 */ }
    }
    onScroll();

    var onTab = state.tab === "moves" ? state.movesBack : state.tab;
    document.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("on", t.getAttribute("data-tab") === onTab); });
    $("badge").hidden = !state.checks.length;
    $("badge").textContent = state.checks.length;
  }

  function onScroll() { $("nav").classList.toggle("scrolled", $("content").scrollTop > 4); }
  $("content").addEventListener("scroll", onScroll, { passive: true });

  function scrollToResult() {
    var res = $("result"), content = $("content");
    if (!res) return;
    var host = $("scannerHost");
    content.scrollTop = Math.max(0, res.offsetTop - (host.hidden ? 0 : host.offsetHeight));
  }

  // ---------- 시트 ----------
  function openSheet(html) {
    $("sheet").innerHTML = '<div class="grabber"></div>' + html;
    $("sheet").hidden = false; $("backdrop").hidden = false;
  }
  function closeSheet() {
    var a = document.activeElement;
    if (a && $("sheet").contains(a)) a.blur();
    $("sheet").hidden = true; $("backdrop").hidden = true;
    sheetExempt = {};
    if (exitOpen) { exitOpen = false; fillBack(); }
  }
  $("backdrop").addEventListener("click", closeSheet);

  // 수량 입력칸: 누르면 커서를 숫자 뒤로 (앞에 있으면 고치기 어려움)
  function caretEnd(el) { try { var n = el.value.length; el.setSelectionRange(n, n); } catch (e) { /* 지원 안 하는 입력칸 */ } }
  document.addEventListener("focusin", function (e) {
    var t = e.target;
    if (!t.classList || !t.classList.contains("qty-in")) return;
    t._focusAt = Date.now();
    setTimeout(function () { caretEnd(t); }, 0);
  });
  document.addEventListener("click", function (e) {
    var t = e.target;
    // 처음 누를 때만 (이미 입력 중에 누른 자리는 그대로)
    if (t.classList && t.classList.contains("qty-in") && Date.now() - (t._focusAt || 0) < 500) caretEnd(t);
  });

  // 확대·축소 막기 — viewport 설정을 무시하는 브라우저(iOS Safari 등)용: 두 손가락 확대 동작 취소
  ["gesturestart", "gesturechange"].forEach(function (t) { document.addEventListener(t, function (e) { e.preventDefault(); }); });
  document.addEventListener("touchmove", function (e) { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

  // ---------- 휴대폰 뒤로가기 ----------
  // 열린 창 닫기 → 화면 안의 '뒤로' → 마지막엔 종료 확인 (한 번에 앱 밖으로 나가지 않게)
  // Chrome 은 화면을 누르지 않은 상태에서 넣은 기록을 뒤로가기 때 건너뛰므로(→ 바로 종료),
  // 누를 때마다 '뒤로' 기록을 BACK_DEPTH 개까지 미리 쌓아 두고, 뒤로가기 땐 새로 넣지 않고 하나씩 씀
  var BACK_DEPTH = 3, exitOpen = false, exitUnwind = false;
  function backDepth() { return (history.state && history.state.dsBack) || 0; }
  function fillBack() {
    if (exitOpen || exitUnwind) return;
    var ua = navigator.userActivation;
    if (ua && !ua.isActive) return;   // 스크립트가 누른 클릭 등은 제외 (건너뛰는 기록이 됨)
    try { for (var d = backDepth(); d < BACK_DEPTH; d++) history.pushState({ dsBack: d + 1 }, ""); } catch (e) { /* 무시 */ }
  }
  document.addEventListener("click", fillBack, true);
  document.addEventListener("keydown", fillBack, true);
  window.addEventListener("popstate", function () {
    var d = backDepth();
    if (exitUnwind) { if (d === 0) { exitUnwind = false; openExit(); } return; }
    if (exitOpen) return;
    var closed = true;
    if ($("reportView")) closeReport();
    else if (!$("sheet").hidden) closeSheet();
    else if ($("rBack") || $("movesBack") || $("auditBack")) ($("rBack") || $("movesBack") || $("auditBack")).click();
    else if (state.tab === "scan" && state.result.length) { state.result = []; render(true); }
    else closed = false;
    if (closed) {
      // 쌓아 둔 기록을 다 썼으면 하나 더 (다음에 화면을 누르면 다시 채워짐)
      if (d === 0) try { history.pushState({ dsBack: 1 }, ""); } catch (e) { /* 무시 */ }
      return;
    }
    // 닫을 게 없음 → 남은 기록을 정리해 맨 앞으로 간 뒤 종료 확인 (그 다음 뒤로가기 = 종료)
    if (d > 0) { exitUnwind = true; history.go(-d); } else openExit();
  });
  function openExit() {
    openSheet(
      '<div class="sheet-head"><span></span><h2>앱 종료</h2><span></span></div>' +
      '<p class="sheet-sub">DS재고 관리를 종료할까요?<br>뒤로 버튼을 한 번 더 누르면 종료됩니다.</p>' +
      '<button class="btn-primary" id="exitYes" style="margin-top:0">종료</button>' +
      '<button class="btn-ghost" id="exitNo">계속 사용</button>'
    );
    exitOpen = true;   // 지금은 기록 맨 앞 — 다음 뒤로가기는 그대로 앱 종료
  }
  function exitApp() {
    exitOpen = false;
    closeSheet();
    history.back();
    try { window.close(); } catch (e) { /* 무시 */ }
    // 홈 화면 앱은 스크립트로 닫을 수 없는 경우가 있음
    setTimeout(function () {
      if (document.hidden) return;
      exitOpen = true; toast("뒤로 버튼을 한 번 더 누르면 종료됩니다");
      setTimeout(function () { exitOpen = false; }, 3000);   // 그 뒤로는 다시 확인
    }, 400);
  }

  function openCheck(pn) {
    var p = state.parts[pn], c = openChecksByItem()[pn], rr = rrQty(pn);
    var start = c ? c.counted_qty : Number(p.crt_qty) + rr;
    openSheet(
      '<div class="sheet-head"><button class="cancel" data-close>취소</button><h2>수량 다름 체크</h2><span></span></div>' +
      '<div class="sheet-loc mono-loc">' + esc(p.lct_cd || "위치 없음") + '</div>' +
      '<div class="sheet-pn">' + esc(pn) + '</div>' +
      '<p class="sheet-sub">' + esc(p.item_nm) + '</p>' +
      '<div class="group">' +
        '<div class="row"><div class="row-main">DMS 수량</div><span class="row-value qty" style="font-size:var(--fs-xl)">' + qtyNum(p.crt_qty) + '</span></div>' +
        (rr ? '<div class="row"><div class="row-main">RR 수량</div><span class="row-value qty" style="font-size:var(--fs-xl)">' + qtyNum(rr) + '</span></div>' +
          '<div class="row"><div class="row-main">합계</div><span class="row-value qty" style="font-size:var(--fs-xl);font-weight:700">' + qtyNum(Number(p.crt_qty) + rr) + '</span></div>' : '') +
        '<div class="row stepper"><div class="row-main">실사 수량</div><div class="stepper-ctl"><button type="button" data-step="-1" aria-label="하나 빼기">−</button><input id="countIn" type="text" inputmode="numeric" autocomplete="off" class="qty-in" value="' + qtyNum(start) + '" aria-label="실사 수량"><button type="button" data-step="1" aria-label="하나 더하기">+</button></div></div>' +
        '<div class="row"><textarea class="field" id="memoIn" rows="2" placeholder="메모 (선택)" aria-label="메모">' + esc(c ? c.memo : "") + '</textarea></div>' +
      '</div>' +
      '<p class="footnote" id="diffHint"></p>' +
      '<button class="btn-primary" id="saveCheck" data-pn="' + esc(pn) + '">저장</button>' +
      (c ? '<button class="btn-plain" id="clearCheck" data-id="' + c.id + '">체크 기록 지우기</button>' : '')
    );
    updateHint(p);
  }
  function updateHint(p) {
    var v = parseFloat($("countIn").value), h = $("diffHint");
    if (isNaN(v)) { h.textContent = "실사 수량을 입력하세요."; $("saveCheck").disabled = true; return; }
    var rr = rrQty(p.item_cd), d = v - Number(p.crt_qty) - rr, base = rr ? "DMS + RR 합계" : "DMS 수량";
    $("saveCheck").disabled = d === 0;
    h.textContent = d === 0 ? base + "과 같아서 체크할 내용이 없습니다." : base + "보다 " + Math.abs(qtyNum(d)) + "개 " + (d > 0 ? "많습니다." : "적습니다.");
  }

  function openMove(pn) {
    var p = state.parts[pn];
    openSheet(
      '<div class="sheet-head"><button class="cancel" data-close>취소</button><h2>위치 변경</h2><span></span></div>' +
      '<p class="sheet-sub"><span class="pn">' + esc(pn) + '</span> · ' + esc(p.item_nm) + '</p>' +
      '<div class="group">' +
        '<div class="row"><div class="row-main">현재 위치</div><span class="row-value mono-loc">' + esc(p.lct_cd || "없음") + '</span></div>' +
        '<div class="row"><div class="row-main">새 위치</div><input class="field" id="newLoc" style="text-align:right;width:55%;font-family:var(--mono)" placeholder="예: A140112" aria-label="새 위치" autocomplete="off" autocapitalize="characters"></div>' +
      '</div>' +
      (daemonStale() ? '<div class="notice">DMS 연결 PC가 응답하지 않아 지금은 위치 변경을 저장할 수 없습니다.</div>' : '') +
      '<p class="footnote">새 위치 라벨을 스캔해도 됩니다. 저장하면 DMS에 변경을 요청하고, 보통 몇 초 안에 반영됩니다. DMS 데이터 갱신 중이면 몇 분 걸릴 수 있습니다.</p>' +
      '<button class="btn-primary" id="saveMove" data-pn="' + esc(pn) + '" disabled>저장</button>'
    );
  }

  // ---------- 이벤트 ----------
  document.addEventListener("click", function (e) {
    if (e.target.closest(".viewfinder") && !e.target.closest("button")) { tapFocus(e); return; }
    var el = e.target.closest("button, [data-close]");
    if (!el || el.disabled) return;
    if (el.hasAttribute("data-tab")) {
      var t = el.getAttribute("data-tab");
      el.blur();
      closeSheet();
      if (t === "scan" && state.tab === "scan") state.result = [];
      if (t === "audit" && state.tab === "audit") { state.auditOpen = null; state.auditLoc = null; }
      if (t === "audit") loadAudits().then(function () { if (state.tab === "audit") render(false); });
      state.tab = t;
      render(true); return;
    }
    if (el.hasAttribute("data-close")) { closeSheet(); return; }
    if (el.hasAttribute("data-mode")) { state.mode = el.getAttribute("data-mode"); store.set("scanMode", state.mode); cam.error = null; renderScanner(); return; }
    if (el.hasAttribute("data-cam-retry")) { cam.error = null; renderScanner(); return; }
    if (el.id === "torchBtn") { toggleTorch(); return; }
    if (el.hasAttribute("data-zoom")) { setZoom(Number(el.getAttribute("data-zoom"))); return; }
    if (el.id === "photoBtn" || el.id === "photoRetry") { closeSheet(); $("photoInput").click(); return; }
    if (el.hasAttribute("data-photo-pick")) { closeSheet(); resolve(el.getAttribute("data-photo-pick"), true, true); return; }
    if (el.id === "photoDiag") { diagPhoto(); return; }
    if (el.id === "diagBtn") { diagLive(); return; }
    if (el.hasAttribute("data-sug")) { var sc = el.getAttribute("data-sug"); hideSuggest(); if ($("manualInput")) $("manualInput").blur(); resolve(sc); return; }
    if (el.hasAttribute("data-go")) {
      var code = el.getAttribute("data-go");
      state.result.push({ type: isLoc(code) ? "loc" : "part", code: code });
      render(false); scrollToResult(); return;
    }
    if (el.hasAttribute("data-open")) {
      var oc = el.getAttribute("data-open");
      state.tab = "scan";
      state.result = [{ type: isLoc(oc) ? "loc" : "part", code: oc }];
      render(true); return;
    }
    if (el.id === "exitYes") { exitApp(); return; }
    if (el.id === "exitNo") { closeSheet(); return; }
    if (el.id === "rBack") { state.result.pop(); render(false); scrollToResult(); return; }
    if (el.id === "rClose") { state.result = []; render(true); return; }
    if (el.hasAttribute("data-sort")) {
      state.sort = el.getAttribute("data-sort");
      document.querySelectorAll("[data-sort]").forEach(function (b) { b.classList.toggle("on", b === el); });
      $("locList").innerHTML = locRows(state.result[state.result.length - 1].code, $("locSearch") ? $("locSearch").value : "");
      return;
    }
    if (el.hasAttribute("data-check")) { openCheck(el.getAttribute("data-check")); return; }
    if (el.hasAttribute("data-move")) { openMove(el.getAttribute("data-move")); return; }
    if (el.hasAttribute("data-rdc-retry")) { var rp = el.getAttribute("data-rdc-retry"); delete state.rdc[rp]; requestRdc(rp); $("rdcTile").innerHTML = rdcTile(rp); return; }
    if (el.hasAttribute("data-refresh")) { refreshPart(el.getAttribute("data-refresh")); return; }
    if (el.hasAttribute("data-step")) {
      var inp = $("countIn");
      inp.value = Math.max(0, (parseFloat(inp.value) || 0) + parseInt(el.getAttribute("data-step"), 10));
      updateHint(state.parts[$("saveCheck").getAttribute("data-pn")]);
      return;
    }
    if (el.id === "saveCheck") { saveCheck(el.getAttribute("data-pn")); return; }
    if (el.id === "clearCheck") { clearCheck(Number(el.getAttribute("data-id"))); return; }
    if (el.id === "saveMove") { saveMove(el.getAttribute("data-pn")); return; }
    if (el.id === "unknownLookup") { lookupUnknown(el.getAttribute("data-pn"), el); return; }
    if (el.hasAttribute("data-logitem")) {
      var c = state.checks.filter(function (x) { return x.id === Number(el.getAttribute("data-logitem")); })[0];
      if (c && state.parts[c.item_cd]) { state.tab = "scan"; state.result = [{ type: "part", code: c.item_cd }]; render(true); }
      return;
    }
    // 재고조사
    if (el.hasAttribute("data-audit")) { openAudit(el.getAttribute("data-audit")); return; }
    if (el.id === "auditBack") { state.auditOpen = null; state.auditLoc = null; if (auditChannel) { sb.removeChannel(auditChannel); auditChannel = null; } render(true); return; }
    if (el.id === "auditStart") { startAudit(el); return; }
    if (el.hasAttribute("data-afilter")) { state.auditFilter = el.getAttribute("data-afilter"); render(false); return; }
    if (el.id === "auditLocClear") { state.auditLoc = null; render(false); return; }
    if (el.hasAttribute("data-aitem")) { openAuditItem(el.getAttribute("data-aitem")); return; }
    if (el.id === "aExemptToggle") { $("aExemptBox").hidden = false; el.hidden = true; $("aExemptIn").focus(); return; }
    if (el.id === "aExemptGo") {
      var why = $("aExemptIn").value.trim();
      if (why.length < 2) { toast("스캔하지 못한 사유를 적어 주세요"); $("aExemptIn").focus(); return; }
      sheetExempt[el.getAttribute("data-pn")] = why;
      openAuditItem(el.getAttribute("data-pn"));
      return;
    }
    if (el.id === "aOk") { el.disabled = true; markAudit(el.getAttribute("data-pn"), "ok", null); return; }
    if (el.id === "aNowBtn") { auditNow(el); return; }
    if (el.id === "aUseNow") {
      if ($("aLock")) { toast("위치를 먼저 스캔하세요"); return; }
      var dn = Number(el.getAttribute("data-d"));
      $("aDiffBox").hidden = false; $("aDiffToggle").hidden = true; $("aOk").hidden = true;
      $("aCountIn").value = el.getAttribute("data-qty");
      if (!$("aMemoIn").value) $("aMemoIn").value = sinceLabel() + " " + (dn < 0 ? "출고 " : "입고 ") + qtyNum(Math.abs(dn)) + "개 (지금 DMS " + el.getAttribute("data-qty") + "개)";
      $("aDiffSave").scrollIntoView({ block: "nearest" });
      return;
    }
    if (el.id === "aDiffToggle") { $("aDiffBox").hidden = false; el.hidden = true; $("aOk").hidden = true; $("aCountIn").focus(); return; }
    if (el.hasAttribute("data-astep")) { var ai = $("aCountIn"); ai.value = Math.max(0, (parseFloat(ai.value) || 0) + parseInt(el.getAttribute("data-astep"), 10)); return; }
    if (el.id === "aDiffSave") {
      var apn = el.getAttribute("data-pn"), av = parseFloat($("aCountIn").value), ait = findAuditItem(apn);
      if (isNaN(av)) { toast("실사 수량을 입력하세요"); return; }
      el.disabled = true;
      if (av === itemTotal(ait)) { markAudit(apn, "ok", null); return; }
      markAudit(apn, "diff", av, $("aMemoIn").value.trim());
      return;
    }
    if (el.id === "exportBtn") { exportChecks(); return; }
    if (el.id === "movesOpen") { openMoveLog("settings"); return; }
    if (el.id === "auditFinish") { openFinish(); return; }
    if (el.id === "auditRefresh") { refreshAudit(el); return; }
    if (el.id === "auditFinishOk") { finishAudit(el); return; }
    if (el.id === "auditReport") { openReport(); return; }
    if (el.id === "auditReopen") { openReopen(); return; }
    if (el.id === "auditReopenOk") { reopenAudit(el); return; }
    if (el.id === "rvClose") { closeReport(); return; }
    if (el.id === "rvShare" || el.id === "rvShare2") { shareReport(); return; }
    if (el.id === "rvDownload") {
      if (!report.file) { toast(report.error ? "PDF 를 만들지 못했습니다" : "PDF 를 만드는 중입니다. 잠시 뒤 다시 눌러 주세요"); return; }
      AuditReport.downloadFile(namedReport()); toast("다운로드 폴더에 저장했습니다"); return;
    }
    if (el.hasAttribute("data-movelog")) { openMoveLog("scan", el.getAttribute("data-movelog")); return; }
    if (el.id === "movesBack") { state.tab = state.movesBack; render(true); if (state.tab === "scan") scrollToResult(); return; }
    if (el.hasAttribute("data-mfilter")) { state.moveFilter = el.getAttribute("data-mfilter"); render(false); return; }
    if (el.id === "logoutBtn") { logout(); return; }
  });

  document.addEventListener("submit", function (e) {
    if (e.target.id === "manual") {
      e.preventDefault();
      var mv = $("manualInput").value, mc = normCode(mv), ml = suggestItems(mc);
      if (!exactCode(mc) && ml.length === 1) mv = ml[0].code;
      hideSuggest(); resolve(mv); $("manualInput").blur();
    }
    if (e.target.id === "loginForm") { e.preventDefault(); login(); }
  });

  document.addEventListener("input", function (e) {
    if (e.target.id === "manualInput") renderSuggest();
    if (e.target.id === "locSearch") {
      var sl = state.result[state.result.length - 1].code;
      state.locQ = { loc: sl, q: e.target.value };
      $("locList").innerHTML = locRows(sl, e.target.value);
    }
    if (e.target.id === "moveSearch") { state.moveQ = e.target.value; $("moveList").innerHTML = moveRows(); }
    if (e.target.classList.contains("qty-in") && /[^0-9.]/.test(e.target.value)) e.target.value = e.target.value.replace(/[^0-9.]/g, "");   // 소수 수량(오일 등)은 그대로
    if (e.target.id === "countIn") updateHint(state.parts[$("saveCheck").getAttribute("data-pn")]);
    if (e.target.id === "newLoc") {
      var v = normCode(e.target.value), pn = $("saveMove").getAttribute("data-pn");
      $("saveMove").disabled = !looksLoc(v) || v === state.parts[pn].lct_cd;
    }
  });
  document.addEventListener("change", function (e) {
    if (e.target.id === "optCam") { store.set("camera", e.target.checked); }
    if (e.target.id === "optSound") { store.set("sound", e.target.checked); }
    if (e.target.id === "optDiag") { store.set("diag", e.target.checked); }
    if (e.target.id === "photoInput") { var pf = e.target.files && e.target.files[0]; e.target.value = ""; scanPhoto(pf); }
  });

  // ---------- 동작 ----------
  async function saveCheck(pn) {
    var p = state.parts[pn], old = openChecksByItem()[pn];
    var v = parseFloat($("countIn").value), memo = $("memoIn").value.trim();
    $("saveCheck").disabled = true;
    var r;
    if (old) r = await sb.from("inv_checks").update({ counted_qty: v, memo: memo || null, dms_qty: p.crt_qty, rr_qty: rrQty(pn) }).eq("id", old.id);
    else r = await sb.from("inv_checks").insert({ item_cd: pn, item_nm: p.item_nm, lct_cd: p.lct_cd, dms_qty: p.crt_qty, rr_qty: rrQty(pn), counted_qty: v, memo: memo || null, checked_by: state.user.id });
    if (r.error) { toast("저장하지 못했습니다: " + r.error.message); $("saveCheck").disabled = false; return; }
    await loadChecks();
    closeSheet(); render(false);
  }
  async function clearCheck(id) {
    var r = await sb.from("inv_checks").update({ cleared_at: new Date().toISOString(), cleared_by_name: state.user.name }).eq("id", id);
    if (r.error) { toast("지우지 못했습니다: " + r.error.message); return; }
    await loadChecks();
    closeSheet(); render(false);
  }

  async function saveMove(pn) {
    var to = normCode($("newLoc").value), from = state.parts[pn].lct_cd || "";
    $("saveMove").disabled = true;
    try {
      var id = await sendRequest("loc_change", pn, { from: from, to: to });
      state.moves[pn] = { from: from, to: to, status: "pending", reqId: id, at: Date.now() };
      closeSheet(); render(false);
      waitRequest(id, function (res) {
        if (res.status === "done") {
          state.moves[pn] = { from: from, to: to, status: "done", time: hhmm(), at: Date.now() };
          var p = state.parts[pn];
          locRemove(p.lct_cd, pn);
          p.lct_cd = to; locAdd(to, pn);
        } else {
          state.moves[pn] = { from: from, to: to, status: "failed", error: res.error, at: Date.now() };
        }
        if (state.tab === "scan" && $("sheet").hidden) render(false); else renderMoveBar();
      });
    } catch (e) {
      if ($("saveMove")) $("saveMove").disabled = false;
      toast("요청하지 못했습니다: " + e.message);
    }
  }

  async function refreshPart(pn) {
    try {
      var id = await sendRequest("stock", pn);
      waitRequest(id, function (res) {
        if (res.status !== "done") { toast("조회 실패: " + (res.error || "")); return; }
        var p = state.parts[pn], r = res.result;
        if (p && r.found) {
          if (p.lct_cd !== r.lct_cd) {
            locRemove(p.lct_cd, pn);
            locAdd(r.lct_cd, pn);
          }
          p.crt_qty = r.crt_qty; p.lct_cd = r.lct_cd;
          if (r.rdc_qty != null) state.rdc[pn] = { status: "done", result: r, at: Date.now() };
        }
        toast("현재고 " + qtyNum(r.crt_qty) + "개 · 위치 " + (r.lct_cd || "없음"));
        if (state.tab === "scan") render(false);
      });
    } catch (e) { toast("요청하지 못했습니다: " + e.message); }
  }

  async function lookupUnknown(pn, btn) {
    btn.disabled = true; btn.textContent = "DMS에서 조회 중…";
    try {
      var id = await sendRequest("stock", pn, { rdc: true });
      waitRequest(id, function (res) {
        if (!$("unknownResult")) return;
        btn.hidden = true;
        if (res.status !== "done") { $("unknownResult").innerHTML = '<p class="sheet-sub" style="color:var(--danger)">' + esc(res.error || "조회 실패") + '</p>'; return; }
        var r = res.result;
        if (!r.found) { $("unknownResult").innerHTML = '<p class="sheet-sub">DMS 부품창고에 없는 품번입니다.<br>RDC 재고 ' + qtyNum(r.rdc_qty) + '개</p>'; return; }
        $("unknownResult").innerHTML = '<p class="sheet-sub">' + esc(r.item_nm) + '</p><div class="bigqty"><span>지점 현재고</span><b>' + qtyNum(r.crt_qty) + '</b><small>EA</small></div>' +
          '<p class="sheet-sub">위치 ' + esc(r.lct_cd || "없음") + ' · RDC 재고 ' + qtyNum(r.rdc_qty) + '개</p>';
      });
    } catch (e) { btn.disabled = false; btn.textContent = "DMS에서 조회"; toast("요청하지 못했습니다: " + e.message); }
  }

  async function startAudit(btn) {
    btn.disabled = true;
    var r = await sb.rpc("inv_start_audit", { p_kind: state.auditOpen });
    if (r.error) { toast("시작하지 못했습니다: " + r.error.message); btn.disabled = false; return; }
    await loadAudits();
    var a = state.audits[state.auditOpen];
    if (a && a.id === r.data && a.started_by !== state.user.id) toast((a.started_by_name || "다른 직원") + "님이 먼저 시작한 조사를 이어서 엽니다");
    await openAudit(state.auditOpen);
  }

  function exportChecks() {
    var rows = [["확인일시", "위치", "품번", "품명", "DMS 수량", "RR 수량", "실사 수량", "차이(실사-DMS-RR)", "확인자", "메모"]];
    state.checks.forEach(function (c) {
      var d = new Date(c.checked_at);
      rows.push([d.toLocaleString("ko-KR"), c.lct_cd || "", c.item_cd, c.item_nm || "", qtyNum(c.dms_qty), qtyNum(Number(c.rr_qty) || 0), qtyNum(c.counted_qty), qtyNum(c.counted_qty - checkBase(c)), c.checked_by_name || "", c.memo || ""]);
    });
    var csv = "﻿" + rows.map(function (r) { return r.map(function (v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(","); }).join("\r\n");
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = "재고조사_체크기록_" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- 로그인 ----------
  async function login() {
    var id = $("loginId").value.trim(), pw = $("loginPw").value;
    $("loginError").textContent = ""; $("loginBtn").disabled = true;
    var r = await sb.auth.signInWithPassword({ email: id.indexOf("@") >= 0 ? id : id + LOGIN_DOMAIN, password: pw });
    if (r.error) {
      $("loginError").textContent = "아이디 또는 비밀번호가 맞지 않습니다.";
      $("loginBtn").disabled = false;
      return;
    }
    await afterLogin(r.data.user);
  }

  async function afterLogin(user) {
    var r = await sb.from("profiles").select("id,login_id,name,role,branch,active,must_change_password").eq("id", user.id).maybeSingle();
    if (r.error || !r.data || !r.data.active) {
      await sb.auth.signOut();
      state.user = null; render(true);
      if ($("loginError")) $("loginError").textContent = "사용할 수 없는 계정입니다. 관리자에게 문의하세요.";
      return;
    }
    state.user = r.data;
    state.loading = true; render(true);
    try {
      await Promise.all([loadStatus(), loadParts(), loadChecks(), loadAudits(), loadRrParts().catch(function () {})]);
      lastPartsAt = state.status && state.status.parts_at;
      lastRrAt = state.status && state.status.rr_parts_at;
    } catch (e) {
      toast("데이터를 불러오지 못했습니다: " + e.message);
    }
    state.loading = false;
    render(true);
    flushOutbox();
    if (r.data.must_change_password) toast("비밀번호 변경이 필요합니다. 태블릿 앱에서 변경해 주세요.");
  }

  async function logout() {
    stopCamera();
    await sb.auth.signOut();
    state.user = null; state.result = []; state.tab = "scan"; state.parts = {}; state.locs = {}; state.checks = []; state.moveLog = null; state.rrParts = {}; state.rdc = {};
    render(true);
  }

  // ---------- 새 버전 자동 적용 ----------
  // 휴대폰 브라우저가 예전 index.html 을 붙잡고 있으면 고친 내용이 안 보이므로, 서버의 버전과 다르면 새로고침
  function checkUpdate() {
    if (!APP_VER || !$("sheet").hidden) return;
    fetch("./", { cache: "reload" }).then(function (r) { return r.ok ? r.text() : ""; }).then(function (t) {
      var m = t.match(/app\.js\?v=(\d+)/);
      if (!m || m[1] === APP_VER) return;
      var tries = 0; try { tries = Number(sessionStorage.getItem("inv.reload." + m[1]) || 0); sessionStorage.setItem("inv.reload." + m[1], tries + 1); } catch (e) { /* 그냥 진행 */ }
      if (tries < 2) location.reload();
    }).catch(function () { /* 오프라인 등은 무시 */ });
  }
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") checkUpdate(); });
  setInterval(checkUpdate, 5 * 60000);

  // ---------- 시작 ----------
  checkUpdate();
  (async function boot() {
    var s = await sb.auth.getSession();
    if (s.data && s.data.session) await afterLogin(s.data.session.user);
    else render(true);
    setInterval(function () { if (state.user && !state.loading) refreshStatus(); }, STATUS_POLL_MS);
  })();
})();
