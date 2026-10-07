/* 해운대 재고조사 — 휴대폰 바코드 재고조사 앱
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
  var REQ_POLL_MS = 1500;             // 요청 처리 결과 확인 주기
  var GROUPS = { A: "상시재고", L: "로컬조달", O: "특수/단종계열", I: "비이동성", S: "특수발주" };

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
    mode: store.get("mode", "camera"),
    sort: "pn",
    parts: {},             // item_cd -> 현재고 행
    locs: {},              // lct_cd -> [item_cd]
    status: null,          // inv_status
    rdc: {},               // item_cd -> {status, result, error, at}
    moves: {},             // item_cd -> {from, to, status, error, time, reqId}
    checks: [],            // 지우지 않은 체크 기록
    recent: store.get("recent", []),
    sources: {},           // kind -> inv_audit_source
    audits: {},            // kind -> 최근 inv_audits
    auditOpen: null,       // 열려 있는 조사 kind
    auditItems: [],        // 열려 있는 조사의 항목
    auditFilter: "left",
    auditLoc: null,
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
  var CHEV = '<svg class="chev" viewBox="0 0 8 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 1.5l5 5-5 5"/></svg>';
  var BACK = '<svg viewBox="0 0 12 20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2L2 10l8 8"/></svg>';
  var CLOSE = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 2l8 8M10 2l-8 8"/></svg>';
  var SEARCH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5"/></svg>';

  var toastTimer;
  function toast(msg) {
    $("toastText").textContent = msg;
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $("toast").hidden = true; }, 2600);
  }

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
  async function loadParts() {
    var all = [], from = 0, size = 1000;
    for (;;) {
      var r = await sb.from("inv_parts").select("item_cd,item_nm,lct_cd,crt_qty,alois_cd,last_purc_dt").order("item_cd").range(from, from + size - 1);
      if (r.error) throw r.error;
      all = all.concat(r.data);
      if (r.data.length < size) break;
      from += size;
    }
    var parts = {}, locs = {};
    all.forEach(function (p) {
      parts[p.item_cd] = p;
      if (p.lct_cd) (locs[p.lct_cd] = locs[p.lct_cd] || []).push(p.item_cd);
    });
    state.parts = parts; state.locs = locs;
  }
  async function loadStatus() {
    var r = await sb.from("inv_status").select("*").maybeSingle();
    if (!r.error) state.status = r.data;
  }
  async function loadChecks() {
    var r = await sb.from("inv_checks").select("*").is("cleared_at", null).order("checked_at", { ascending: false }).limit(500);
    if (!r.error) state.checks = r.data;
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
  }

  var lastPartsAt = null;
  async function refreshStatus() {
    await loadStatus();
    var at = state.status && state.status.parts_at;
    if (at && at !== lastPartsAt) {   // 데몬이 새로 올렸으면 현재고 다시 받기
      lastPartsAt = at;
      await loadParts();
      await loadAudits();
    }
    render(false);
  }

  // ---------- 데몬 요청 ----------
  async function sendRequest(kind, pn, params) {
    var r = await sb.from("inv_requests").insert({ kind: kind, item_cd: pn, params: params || {} }).select("id").single();
    if (r.error) throw r.error;
    return r.data.id;
  }
  function waitRequest(id, onDone) {
    var tries = 0;
    (function tick() {
      sb.from("inv_requests").select("status,result,error").eq("id", id).single().then(function (r) {
        tries++;
        if (!r.error && (r.data.status === "done" || r.data.status === "failed")) { onDone(r.data); return; }
        if (tries > 400) { onDone({ status: "failed", error: "응답이 없습니다 (데몬 확인 필요)" }); return; }
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
  function resolve(raw, fromScanner) {
    var code = normCode(raw);
    if (!code) return;
    if (fromScanner) {
      var t = Date.now();
      if (code === lastScan.code && t - lastScan.at < SCAN_COOLDOWN_MS) return;
      lastScan = { code: code, at: t };
    }
    if (/^Z/.test(code)) { toast("Z로 시작하는 서비스 코드는 조회하지 않습니다"); return; }

    // 위치 변경 창이 열려 있으면 스캔한 위치를 새 위치 칸에 넣음
    if (!$("sheet").hidden) {
      if ($("newLoc") && looksLoc(code)) { $("newLoc").value = code; $("newLoc").dispatchEvent(new Event("input", { bubbles: true })); beep(); }
      return;
    }
    if (fromScanner) beep();
    if ($("manualInput")) $("manualInput").value = "";

    if (state.tab === "audit" && state.auditOpen && currentAudit()) { auditScan(code); return; }

    var type = isLoc(code) ? "loc" : state.parts[code] ? "part" : null;
    if (!type) {
      if (/^[A-Z0-9]{5,20}$/.test(code) && !looksLoc(code)) { openUnknownPart(code); return; }
      toast(looksLoc(code) ? "이 위치에 있는 부품이 없습니다: " + code : "등록된 부품이나 위치가 아닙니다: " + code);
      return;
    }
    pushRecent(code);
    state.tab = "scan";
    state.result = [{ type: type, code: code }];
    render(true);
  }
  function pushRecent(code) {
    state.recent = [{ code: code, time: hhmm() }].concat(state.recent.filter(function (r) { return r.code !== code; })).slice(0, 50);
    store.set("recent", state.recent);
  }

  // 블루투스 스캐너는 키보드처럼 입력된 뒤 Enter
  var buf = "", bufTimer;
  document.addEventListener("keydown", function (e) {
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (e.key === "Enter") { if (buf.length >= 5) resolve(buf, true); buf = ""; return; }
    if (e.key.length === 1 && /[0-9A-Za-z\- ]/.test(e.key)) {
      if (e.key === " ") e.preventDefault();
      buf += e.key;
      clearTimeout(bufTimer);
      bufTimer = setTimeout(function () { buf = ""; }, 300);
    }
  });

  // ---------- 카메라 ----------
  // 휴대폰에 내장 바코드 인식(BarcodeDetector, 주로 안드로이드 크롬)이 있으면 그걸 쓰고, 없으면(아이폰) ZXing 1D 전용 리더.
  // 1D 바코드는 가로로 길고 가늘어서 해상도와 초점이 중요: 1080p 요청 + 연속 초점(지원 폰만)
  var ONE_D = ["code_128", "code_39", "code_93", "codabar", "ean_13", "ean_8", "itf", "upc_a", "upc_e"];
  var cam = { stream: null, controls: null, timer: null, starting: false, error: null, torchOk: false, torchOn: false, engine: "" };
  function cameraWanted() {
    var host = $("scannerHost");
    return state.user && state.mode === "camera" && store.get("camera", true) && host && !host.hidden && document.visibilityState === "visible";
  }
  function onCameraRead(text) {
    var cap = document.querySelector(".vf-caption");
    if (cap) { cap.textContent = "인식: " + text; clearTimeout(cam.capTimer); cam.capTimer = setTimeout(function () { if (cap.isConnected) cap.textContent = "바코드를 가로로 맞추면 계속 읽습니다"; }, 2500); }
    resolve(text, true);
  }
  async function syncCamera() {
    if (!cameraWanted()) { stopCamera(); return; }
    if (cam.stream || cam.starting) return;
    var video = $("camVideo");
    if (!video) return;
    cam.starting = true; cam.error = null;
    try {
      var stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      cam.stream = stream;
      var track = stream.getVideoTracks()[0];
      try {
        var caps = track.getCapabilities ? track.getCapabilities() : {};
        if (caps.focusMode && caps.focusMode.indexOf("continuous") >= 0) await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
        cam.torchOk = !!caps.torch;
      } catch (e) { /* 초점·플래시 설정을 지원하지 않는 폰 */ }

      var native = null;
      if ("BarcodeDetector" in window) {
        try {
          var sup = await window.BarcodeDetector.getSupportedFormats();
          var fmts = ONE_D.filter(function (f) { return sup.indexOf(f) >= 0; });
          if (fmts.indexOf("code_128") >= 0) native = new window.BarcodeDetector({ formats: fmts });
        } catch (e) { native = null; }
      }
      if (native) {
        cam.engine = "native";
        video.srcObject = stream;
        await video.play();
        var busy = false;
        cam.timer = setInterval(function () {
          if (busy || video.readyState < 2) return;
          busy = true;
          native.detect(video).then(function (codes) {
            busy = false;
            if (codes && codes.length) onCameraRead(codes[0].rawValue);
          }, function () { busy = false; });
        }, 120);
      } else {
        cam.engine = "zxing";
        var F = ZXing.BarcodeFormat, H = ZXing.DecodeHintType, hints = new Map();
        hints.set(H.POSSIBLE_FORMATS, [F.CODE_128, F.CODE_39, F.CODE_93, F.CODABAR, F.EAN_13, F.EAN_8, F.ITF, F.UPC_A, F.UPC_E]);
        hints.set(H.TRY_HARDER, true);
        var reader = new ZXingBrowser.BrowserMultiFormatOneDReader(hints, { delayBetweenScanAttempts: 60, delayBetweenScanSuccess: 300 });
        cam.controls = await reader.decodeFromStream(stream, video, function (result) { if (result) onCameraRead(result.getText()); });
      }
      if (cam.torchOk && $("torchBtn")) $("torchBtn").hidden = false;
    } catch (e) {
      stopCamera();
      cam.error = e && e.name === "NotAllowedError" ? "카메라 권한이 꺼져 있습니다. 브라우저 설정에서 허용해 주세요."
        : e && e.name === "NotFoundError" ? "카메라를 찾지 못했습니다." : "카메라를 켜지 못했습니다. (" + (e && e.name || "오류") + ")";
      renderScanner();
    }
    cam.starting = false;
    if (!cameraWanted()) stopCamera();
  }
  function stopCamera() {
    if (cam.controls) { try { cam.controls.stop(); } catch (e) { /* 이미 멈춤 */ } cam.controls = null; }
    if (cam.timer) { clearInterval(cam.timer); cam.timer = null; }
    if (cam.stream) { cam.stream.getTracks().forEach(function (t) { t.stop(); }); cam.stream = null; }
    cam.torchOn = false;
  }
  function toggleTorch() {
    if (!cam.stream) return;
    cam.torchOn = !cam.torchOn;
    cam.stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: cam.torchOn }] }).catch(function () { cam.torchOn = false; });
    if ($("torchBtn")) $("torchBtn").classList.toggle("on", cam.torchOn);
  }
  document.addEventListener("visibilitychange", syncCamera);

  function renderScanner() {
    var host = $("scannerHost");
    var mode = '<div class="vf-mode"><button class="' + (state.mode === "camera" ? "on" : "") + '" data-mode="camera">카메라</button><button class="' + (state.mode === "bt" ? "on" : "") + '" data-mode="bt">스캐너</button></div>';
    var vf;
    if (state.mode === "camera" && store.get("camera", true)) {
      vf = '<div class="viewfinder" role="img" aria-label="카메라 스캔 화면"><video id="camVideo" playsinline muted autoplay></video>' + mode +
        '<button class="torch" id="torchBtn" hidden aria-label="플래시">플래시</button>' +
        (cam.error ? '<div class="vf-off"><div>' + esc(cam.error) + '<br><button data-cam-retry>다시 시도</button></div></div>'
          : '<div class="vf-frame"><span></span><span></span><span></span><span></span></div><div class="vf-line"></div><div class="vf-caption">바코드를 가로로 맞추면 계속 읽습니다</div>') +
        '</div>';
    } else {
      vf = '<div class="viewfinder bt"><div class="bt-line"><span class="dot"></span>스캐너로 바로 스캔하세요</div>' + mode + '</div>';
    }
    stopCamera();
    host.innerHTML = '<div class="scanner">' + vf +
      '<form class="search" id="manual" autocomplete="off">' + SEARCH + '<input id="manualInput" inputmode="text" autocapitalize="characters" placeholder="품번 또는 위치 직접 입력" aria-label="품번 또는 위치"><button type="submit">조회</button></form>' +
      (daemonStale() ? '<div class="notice" style="margin:8px 0 0">DMS 연결 PC가 응답하지 않습니다. 재고는 ' + basis() + ' 기준이고, RDC 조회·위치 변경은 연결되면 처리됩니다.</div>' : '') +
      '</div>';
    setTimeout(syncCamera, 0);
  }

  // ---------- 스캔 탭 ----------
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
      var d = c ? c.counted_qty - c.dms_qty : 0;
      return '<div class="prow">' +
        '<button class="row-btn" data-go="' + esc(p.item_cd) + '"><div class="row-main"><div class="pn">' + esc(p.item_cd) + '</div><div class="row-sub">' + esc(p.item_nm) + '</div>' +
        (c ? '<div class="diff-note">실사 ' + qtyNum(c.counted_qty) + ' · 차이 ' + (d > 0 ? "+" : "−") + Math.abs(qtyNum(d)) + '</div>' : '') +
        '</div><div class="qty">' + qtyNum(p.crt_qty) + '<small>EA</small></div></button>' +
        '<button class="check' + (c ? " on" : "") + '" data-check="' + esc(p.item_cd) + '" aria-label="' + esc(p.item_cd) + ' 수량 다름 체크"><i></i></button>' +
      '</div>';
    }).join("") + '</div>';
  }

  function viewLoc(loc) {
    var list = partsAt(loc);
    var chk = openChecksByItem();
    var total = list.reduce(function (s, p) { return s + Number(p.crt_qty); }, 0);
    var checked = list.filter(function (p) { return chk[p.item_cd]; }).length;
    return resultHead("위치", loc) +
      '<p class="meta" style="margin-bottom:12px">해운대 부품창고 · ' + basis() + ' 기준</p>' +
      '<div class="summary"><div><b>' + list.length + '</b><span>부품 종류</span></div><div><b>' + qtyNum(total).toLocaleString() + '</b><span>총 수량</span></div><div class="' + (checked ? "w" : "") + '"><b>' + checked + '</b><span>수량 다름</span></div></div>' +
      (list.length > 12 ? '<div class="search" style="margin-top:0">' + SEARCH + '<input id="locSearch" placeholder="이 위치에서 품번·품명 찾기" aria-label="이 위치에서 찾기"></div>' : '') +
      '<div class="seg" role="tablist">' +
        '<button data-sort="pn" class="' + (state.sort === "pn" ? "on" : "") + '">품번순</button>' +
        '<button data-sort="qty" class="' + (state.sort === "qty" ? "on" : "") + '">수량 많은순</button>' +
        '<button data-sort="check" class="' + (state.sort === "check" ? "on" : "") + '">체크 먼저</button>' +
      '</div>' +
      '<div id="locList">' + locRows(loc, "") + '</div>' +
      '<p class="footnote">수량이 다르면 오른쪽 동그라미를 눌러 실사 수량을 남기세요.</p>';
  }

  function rdcTile(pn) {
    var r = state.rdc[pn];
    if (!r || r.status === "pending") {
      return '<div class="tile-label">RDC 재고</div><div class="shimmer"></div><div class="tile-foot">' + (daemonStale() ? "DMS 연결 대기 중" : "DMS에서 조회 중") + '</div>';
    }
    if (r.status === "failed") {
      return '<div class="tile-label">RDC 재고</div><div class="rdc-err">' + esc(r.error || "조회 실패") + '</div><div class="tile-foot"><button class="btn-inline" data-rdc-retry="' + esc(pn) + '">다시 조회</button></div>';
    }
    var q = qtyNum(r.result && r.result.rdc_qty || 0);
    return '<div class="tile-label">RDC 재고</div><div class="tile-num' + (q ? "" : " zero") + '">' + q.toLocaleString() + '<small>EA</small></div><div class="tile-foot">' + hhmm(r.at) + ' 조회</div>';
  }

  function moveBanner(pn) {
    var m = state.moves[pn];
    if (!m) return "";
    if (m.status === "pending") return '<div class="banner info"><span class="spin" aria-hidden="true"></span>DMS 반영 중 · ' + esc(m.from || "공란") + ' → ' + esc(m.to) + '</div>';
    if (m.status === "failed") return '<div class="banner">위치 변경 실패 · ' + esc(m.error || "") + '</div>';
    return '<div class="banner ok">DMS 반영 완료 · ' + esc(m.from || "공란") + ' → ' + esc(m.to) + ' · ' + m.time + '</div>';
  }

  function viewPart(pn) {
    var p = state.parts[pn];
    var c = openChecksByItem()[pn];
    requestRdc(pn);
    var moving = state.moves[pn] && state.moves[pn].status === "pending";
    return resultHead("부품", pn) +
      '<p class="meta" style="margin-bottom:12px">' + esc(p.item_nm) + '</p>' +
      '<div class="stock">' +
        '<div class="tile"><div class="tile-label">지점 현재고</div><div class="tile-num' + (Number(p.crt_qty) ? "" : " zero") + '">' + qtyNum(p.crt_qty) + '<small>EA</small></div>' +
          (p.lct_cd ? '<button class="loc-btn" data-go="' + esc(p.lct_cd) + '"><span>위치</span><b class="mono-loc">' + esc(p.lct_cd) + '</b> ›</button>' : '<span class="tag warn" style="margin-top:10px">위치 없음</span>') +
        '</div>' +
        '<div class="tile rdc" id="rdcTile" data-pn="' + esc(pn) + '">' + rdcTile(pn) + '</div>' +
      '</div>' +
      moveBanner(pn) +
      (c ? '<div class="banner">수량 다름 체크됨 · DMS ' + qtyNum(c.dms_qty) + ' / 실사 ' + qtyNum(c.counted_qty) + (c.memo ? ' · ' + esc(c.memo) : '') + '</div>' : '') +
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
      '</div>';
  }

  function viewScan() {
    var r = state.result.length ? state.result[state.result.length - 1] : null;
    if (r && r.type === "loc" && !isLoc(r.code)) r = null;
    if (r && r.type === "part" && !state.parts[r.code]) r = null;
    var body = !r ? viewIdle() : r.type === "loc" ? viewLoc(r.code) : viewPart(r.code);
    return '<div id="result">' + body + '</div>';
  }

  // 현재고 목록에 없는 품번: DMS에서 직접 조회할지 묻기
  function openUnknownPart(pn) {
    openSheet(
      '<div class="sheet-head"><button class="cancel" data-close>닫기</button><h2>목록에 없는 품번</h2><span></span></div>' +
      '<div class="sheet-loc mono-loc">' + esc(pn) + '</div>' +
      '<p class="sheet-sub">' + basis() + ' 기준 부품창고 현재고 목록에 없습니다.<br>재고가 0이거나 다른 창고에 있을 수 있습니다.</p>' +
      '<button class="btn-primary" id="unknownLookup" data-pn="' + esc(pn) + '">DMS에서 조회</button>' +
      '<div id="unknownResult"></div>'
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
    return kind === "daily" ? md(s.period_start) + " 입고분" : md(s.period_start) + " ~ " + md(s.period_end) + " 출고분";
  }
  var AUDIT_TITLE = { daily: "일일 재고조사", weekly: "주간 재고조사" };
  var AUDIT_RULE = { daily: "오늘 입고된 부품 중 현재고가 있는 부품", weekly: "지난주 월~토 출고된 부품 중 현재고가 있는 부품" };
  var auditCounts = {};   // audit_id -> {done, diff} (홈 카드용)

  function viewAuditHome() {
    var cards = ["daily", "weekly"].map(function (k) {
      var s = state.sources[k], a = state.audits[k];
      var live = a && s && a.period_start === s.period_start && a.period_end === s.period_end ? a : null;
      var st = live && auditCounts[live.id];
      var total = live ? live.item_count : (s ? s.items.length : 0);
      var status = !live ? '<span class="pill">시작 전</span>'
        : st && st.done === total ? '<span class="pill ok">완료</span>' : '<span class="pill run">진행 중</span>';
      var foot = !live ? total + '건 · 시작하면 목록이 고정됩니다'
        : (st ? st.done : 0) + ' / ' + total + ' 확인' + (st && st.diff ? ' · <b class="warn-text">수량 다름 ' + st.diff + '</b>' : '') + ' · ' + hhmm(live.started_at) + ' ' + esc(live.started_by_name || "") + ' 시작';
      return '<button class="acard" data-audit="' + k + '"' + (s ? '' : ' disabled') + '>' +
        '<div class="acard-top"><div class="row-main"><div class="acard-title">' + AUDIT_TITLE[k] + '</div><div class="row-sub">' + periodLabel(k, s) + '</div></div>' + status + CHEV + '</div>' +
        (live && st ? progressBar({ done: st.done, total: total }) : '') +
        '<div class="acard-foot">' + foot + '</div></button>';
    }).join("");
    return '<h1 class="large">재고조사</h1><p class="meta">해운대 부품창고 · 위치 순서대로 확인</p>' +
      '<div class="acards">' + cards + '</div>' +
      '<p class="footnote">일일: ' + AUDIT_RULE.daily + '<br>주간: ' + AUDIT_RULE.weekly + '<br>수량은 그 부품의 현재고 전체입니다.</p>';
  }

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
      var mark = it.status === "ok" ? '<span class="pill ok">일치</span>'
        : it.status === "diff" ? '<span class="pill warn">실사 ' + qtyNum(it.counted) + '</span>' : '';
      html += '<button class="row' + (it.status ? " done" : "") + '" data-aitem="' + esc(it.item_cd) + '"' + (started ? '' : ' disabled') + '>' +
        '<div class="row-main"><div class="pn">' + esc(it.item_cd) + '</div><div class="row-sub">' + esc(it.item_nm) + (it.checked_by_name ? ' · ' + esc(it.checked_by_name) : '') + '</div></div>' +
        '<div class="qty">' + qtyNum(it.qty) + '<small>EA</small></div>' + mark + '</button>';
    });
    return html + '</div>';
  }

  function viewAuditList() {
    var k = state.auditOpen, s = state.sources[k], a = currentAudit();
    var head = '<button class="rback" id="auditBack">' + BACK + '재고조사</button>' +
      '<div class="rhead"><div class="rmain"><h2 class="rtitle">' + AUDIT_TITLE[k] + '</h2></div></div>' +
      '<p class="meta" style="margin-bottom:12px">' + periodLabel(k, s) + (a ? ' · ' + hhmm(a.started_at) + ' 시작' : '') + '</p>';
    if (!a) {
      var items = (s ? s.items : []).map(function (x) { return { item_cd: x.item_cd, item_nm: x.item_nm, lct_cd: x.lct_cd, qty: x.qty }; });
      items.sort(function (x, y) { return (x.lct_cd || "~").localeCompare(y.lct_cd || "~") || x.item_cd.localeCompare(y.item_cd); });
      var locN = {}; items.forEach(function (x) { locN[x.lct_cd || ""] = 1; });
      return head +
        '<div class="summary"><div><b>' + items.length + '</b><span>조사할 부품</span></div><div><b>' + Object.keys(locN).length + '</b><span>위치</span></div></div>' +
        '<button class="btn-primary" id="auditStart" style="margin-top:0"' + (items.length ? '' : ' disabled') + '>조사 시작</button>' +
        '<p class="footnote">시작하면 지금 목록(' + items.length + '건)으로 고정됩니다.' + (k === "daily" ? ' 이후 입고되는 부품은 다음 조사에 들어갑니다.' : '') + '</p>' +
        '<div class="section-label">조사할 부품 미리보기</div>' + auditRows(items, false);
    }
    var st = auditStatsOf(state.auditItems);
    return head +
      '<div class="aprog"><div class="aprog-nums"><b>' + st.done + '</b> / ' + st.total + ' 확인' + (st.diff ? ' · <span class="warn-text">수량 다름 ' + st.diff + '</span>' : '') + '</div>' + progressBar(st) + '</div>' +
      (st.left === 0 ? '<div class="banner ok">조사를 마쳤습니다 · 수량 다름 ' + st.diff + '건은 체크 기록에 있습니다</div>' : '') +
      (state.auditLoc ? '<div class="locchip"><span>위치 <b class="mono-loc">' + esc(state.auditLoc) + '</b>만 보는 중</span><button id="auditLocClear" aria-label="위치 필터 해제">' + CLOSE + '</button></div>' : '') +
      '<div class="seg" role="tablist">' +
        '<button data-afilter="left" class="' + (state.auditFilter === "left" ? "on" : "") + '">남은 것 ' + st.left + '</button>' +
        '<button data-afilter="diff" class="' + (state.auditFilter === "diff" ? "on" : "") + '">수량 다름 ' + st.diff + '</button>' +
        '<button data-afilter="all" class="' + (state.auditFilter === "all" ? "on" : "") + '">전체 ' + st.total + '</button>' +
      '</div>' +
      auditRows(state.auditItems, true) +
      '<p class="footnote">위치 바코드를 찍으면 그 위치만 보이고, 부품 바코드를 찍으면 확인 창이 열립니다.</p>';
  }

  function viewAudit() {
    if (!state.auditOpen) return viewAuditHome();
    return '<div id="result">' + viewAuditList() + '</div>';
  }

  function findAuditItem(pn) { for (var i = 0; i < state.auditItems.length; i++) if (state.auditItems[i].item_cd === pn) return state.auditItems[i]; return null; }

  function auditScan(code) {
    var it = findAuditItem(code);
    if (it) { pushRecent(code); openAuditItem(code); return; }
    var n = state.auditItems.filter(function (x) { return x.lct_cd === code; }).length;
    if (n) {
      state.auditLoc = code; state.auditFilter = "left";
      render(false); scrollToResult();
      toast("위치 " + code + " · 조사할 부품 " + n + "건");
      return;
    }
    toast("이 조사 목록에 없는 바코드입니다: " + code);
  }

  function openAuditItem(pn) {
    var it = findAuditItem(pn);
    var prev = it.status === "ok" ? '<p class="sheet-sub">' + hhmm(it.checked_at) + ' ' + esc(it.checked_by_name || "") + ' · 일치로 확인함</p>'
      : it.status === "diff" ? '<p class="sheet-sub warn-text">' + hhmm(it.checked_at) + ' ' + esc(it.checked_by_name || "") + ' · 실사 ' + qtyNum(it.counted) + '개로 기록함</p>' : '';
    openSheet(
      '<div class="sheet-head"><button class="cancel" data-close>닫기</button><h2>재고 확인</h2><span></span></div>' +
      '<div class="sheet-loc mono-loc">' + esc(it.lct_cd || "위치 없음") + '</div>' +
      '<p class="sheet-sub"><span class="pn">' + esc(pn) + '</span><br>' + esc(it.item_nm) + '</p>' +
      '<div class="bigqty"><span>DMS 현재고</span><b>' + qtyNum(it.qty) + '</b><small>EA</small></div>' + prev +
      '<button class="btn-primary" id="aOk" data-pn="' + esc(pn) + '">일치</button>' +
      '<button class="btn-ghost" id="aDiffToggle">수량 다름</button>' +
      '<div id="aDiffBox" hidden>' +
        '<div class="group" style="margin-top:12px"><div class="row stepper"><div class="row-main">실사 수량</div><div class="stepper-ctl"><button type="button" data-astep="-1" aria-label="하나 빼기">−</button><input id="aCountIn" type="number" inputmode="numeric" min="0" value="' + qtyNum(it.status === "diff" ? it.counted : it.qty) + '" aria-label="실사 수량"><button type="button" data-astep="1" aria-label="하나 더하기">+</button></div></div>' +
        '<div class="row"><textarea class="field" id="aMemoIn" rows="2" placeholder="메모 (선택)" aria-label="메모"></textarea></div></div>' +
        '<button class="btn-primary" id="aDiffSave" data-pn="' + esc(pn) + '">수량 다름으로 저장</button>' +
      '</div>'
    );
  }

  async function markAudit(pn, status, counted, memo) {
    var a = currentAudit(), it = findAuditItem(pn);
    var r = await sb.from("inv_audit_items").update({ status: status, counted: counted, memo: memo || null })
      .eq("audit_id", a.id).eq("item_cd", pn).select().single();
    if (r.error) { toast("저장하지 못했습니다: " + r.error.message); return; }
    Object.assign(it, r.data);
    if (status === "diff") {
      await sb.from("inv_checks").insert({ item_cd: pn, item_nm: it.item_nm, lct_cd: it.lct_cd, dms_qty: it.qty, counted_qty: counted,
        memo: memo || (AUDIT_TITLE[a.kind] + " 중 확인"), audit_id: a.id, checked_by: state.user.id });
      await loadChecks();
    }
    auditCounts[a.id] = auditStatsOf(state.auditItems);
    closeSheet(); render(false);
    var s = auditStatsOf(state.auditItems);
    toast(status === "ok" ? "일치 · " + pn + " (" + s.done + "/" + s.total + ")" : "수량 다름 저장 · 체크 기록에 추가했습니다");
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
      .subscribe();
  }

  // ---------- 다른 탭 ----------
  function viewRecent() {
    var rows = state.recent.map(function (r) {
      var loc = isLoc(r.code), part = state.parts[r.code];
      if (!loc && !part) return "";
      var title = loc ? '<span class="row-title mono-loc">' + esc(r.code) + '</span>' : '<span class="pn">' + esc(r.code) + '</span>';
      var sub = loc ? "부품 " + partsAt(r.code).length + "종" : part.item_nm;
      return '<button class="row" data-open="' + esc(r.code) + '"><span class="tag ' + (loc ? "loc" : "") + '">' + (loc ? "위치" : "부품") + '</span><div class="row-main">' + title + '<div class="row-sub">' + esc(sub) + '</div></div><span class="row-value" style="font-size:13px">' + r.time + '</span>' + CHEV + '</button>';
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
      var diff = c.counted_qty - c.dms_qty;
      html += '<button class="row" data-logitem="' + c.id + '"><div class="row-main"><div class="pn">' + esc(c.item_cd) + '</div><div class="row-sub">' + esc(c.item_nm) + '</div><div class="row-sub">' + esc(c.lct_cd || "-") + ' · ' + hhmm(c.checked_at) + ' · ' + esc(c.checked_by_name || "") + (c.memo ? ' · ' + esc(c.memo) : '') + '</div></div>' +
        '<div class="diff"><b>' + qtyNum(c.dms_qty) + ' → ' + qtyNum(c.counted_qty) + '</b><span class="tag warn">' + (diff > 0 ? "+" : "−") + Math.abs(qtyNum(diff)) + '</span></div></button>';
    });
    return head +
      '<div style="margin-bottom:6px"><button class="btn-secondary" id="exportBtn">엑셀로 내보내기</button></div>' + html + '</div>' +
      '<p class="footnote">DMS 수량은 체크한 시점의 값입니다. 재고를 정정한 뒤 기록을 지우면 목록에서 사라집니다.</p>';
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
        '<div class="row"><div class="row-main">스캔 성공 시 소리·진동</div><label class="switch"><input type="checkbox" id="optSound"' + (store.get("sound", true) ? " checked" : "") + ' aria-label="스캔 성공 시 소리"><i></i></label></div>' +
      '</div>' +
      '<p class="footnote">블루투스 스캐너는 휴대폰에 키보드로 연결하면 바로 쓸 수 있습니다.</p>' +
      '<div class="section-label">데이터</div>' +
      '<div class="group">' +
        '<div class="row"><div class="row-main">현재고 기준 시각</div><span class="row-value">' + basis() + '</span></div>' +
        '<div class="row"><div class="row-main">부품창고 품목</div><span class="row-value">' + Object.keys(state.parts).length.toLocaleString() + '건</span></div>' +
        '<div class="row"><div class="row-main">DMS 연결 PC</div><span class="row-value">' + (daemonStale() ? '<span style="color:var(--danger)">응답 없음</span>' : '<span class="dot" style="display:inline-block;margin-right:6px"></span>연결됨 · ' + hhmm(s.daemon_seen_at)) + '</span></div>' +
        '<div class="row"><div class="row-main">제외</div><span class="row-value">Z 서비스 코드</span></div>' +
      '</div>' +
      '<div class="section-label"></div>' +
      '<div class="group"><button class="row" id="logoutBtn"><div class="row-main row-danger">로그아웃</div></button></div>';
  }

  function viewLogin() {
    return '<form class="login" id="loginForm" autocomplete="on">' +
      '<h1>해운대 재고조사</h1><p class="meta">태블릿 입출고 앱과 같은 아이디로 로그인하세요</p>' +
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
    else if (state.tab === "audit") html = viewAudit();
    else html = viewScan();

    var withScanner = state.tab === "scan" || (state.tab === "audit" && state.auditOpen && !!currentAudit());
    showScanner(withScanner);

    if (state.tab === "scan") {
      nav.innerHTML = '<span></span><span class="nav-title always">스캔</span><span class="nav-meta">' + basis() + ' 기준</span>';
    } else if (state.tab === "audit" && state.auditOpen) {
      nav.innerHTML = '<span></span><span class="nav-title always">' + AUDIT_TITLE[state.auditOpen] + '</span><span class="nav-meta">' + basis() + ' 기준</span>';
    } else {
      nav.innerHTML = '<span></span><span class="nav-title">' + ({ log: "체크 기록", recent: "최근 스캔", settings: "설정", audit: "재고조사" }[state.tab]) + '</span><span></span>';
    }

    var top = content.scrollTop;
    view(html);
    content.scrollTop = resetScroll ? 0 : top;
    onScroll();

    document.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("on", t.getAttribute("data-tab") === state.tab); });
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
  function closeSheet() { $("sheet").hidden = true; $("backdrop").hidden = true; }
  $("backdrop").addEventListener("click", closeSheet);

  function openCheck(pn) {
    var p = state.parts[pn], c = openChecksByItem()[pn];
    var start = c ? c.counted_qty : p.crt_qty;
    openSheet(
      '<div class="sheet-head"><button class="cancel" data-close>취소</button><h2>수량 다름 체크</h2><span></span></div>' +
      '<div class="sheet-loc mono-loc">' + esc(p.lct_cd || "위치 없음") + '</div>' +
      '<p class="sheet-sub"><span class="pn">' + esc(pn) + '</span><br>' + esc(p.item_nm) + '</p>' +
      '<div class="group">' +
        '<div class="row"><div class="row-main">DMS 수량</div><span class="row-value qty" style="font-size:18px">' + qtyNum(p.crt_qty) + '</span></div>' +
        '<div class="row stepper"><div class="row-main">실사 수량</div><div class="stepper-ctl"><button type="button" data-step="-1" aria-label="하나 빼기">−</button><input id="countIn" type="number" inputmode="numeric" min="0" value="' + qtyNum(start) + '" aria-label="실사 수량"><button type="button" data-step="1" aria-label="하나 더하기">+</button></div></div>' +
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
    var d = v - Number(p.crt_qty);
    $("saveCheck").disabled = d === 0;
    h.textContent = d === 0 ? "DMS 수량과 같아서 체크할 내용이 없습니다." : "DMS보다 " + Math.abs(qtyNum(d)) + "개 " + (d > 0 ? "많습니다." : "적습니다.");
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
      '<p class="footnote">새 위치 라벨을 스캔해도 됩니다. 저장하면 DMS에 변경을 요청하고, 보통 몇 초 안에 반영됩니다. DMS 데이터 갱신 중이면 몇 분 걸릴 수 있습니다.</p>' +
      '<button class="btn-primary" id="saveMove" data-pn="' + esc(pn) + '" disabled>저장</button>'
    );
  }

  // ---------- 이벤트 ----------
  document.addEventListener("click", function (e) {
    var el = e.target.closest("button, [data-close]");
    if (!el || el.disabled) return;
    if (el.hasAttribute("data-tab")) {
      var t = el.getAttribute("data-tab");
      if (t === "scan" && state.tab === "scan") state.result = [];
      if (t === "audit" && state.tab === "audit") { state.auditOpen = null; state.auditLoc = null; }
      if (t === "audit") loadAudits().then(function () { if (state.tab === "audit") render(false); });
      state.tab = t;
      render(true); return;
    }
    if (el.hasAttribute("data-close")) { closeSheet(); return; }
    if (el.hasAttribute("data-mode")) { state.mode = el.getAttribute("data-mode"); store.set("mode", state.mode); cam.error = null; renderScanner(); return; }
    if (el.hasAttribute("data-cam-retry")) { cam.error = null; renderScanner(); return; }
    if (el.id === "torchBtn") { toggleTorch(); return; }
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
    if (el.id === "aOk") { el.disabled = true; markAudit(el.getAttribute("data-pn"), "ok", null); return; }
    if (el.id === "aDiffToggle") { $("aDiffBox").hidden = false; el.hidden = true; $("aOk").hidden = true; $("aCountIn").focus(); return; }
    if (el.hasAttribute("data-astep")) { var ai = $("aCountIn"); ai.value = Math.max(0, (parseFloat(ai.value) || 0) + parseInt(el.getAttribute("data-astep"), 10)); return; }
    if (el.id === "aDiffSave") {
      var apn = el.getAttribute("data-pn"), av = parseFloat($("aCountIn").value), ait = findAuditItem(apn);
      if (isNaN(av)) { toast("실사 수량을 입력하세요"); return; }
      el.disabled = true;
      if (av === Number(ait.qty)) { markAudit(apn, "ok", null); return; }
      markAudit(apn, "diff", av, $("aMemoIn").value.trim());
      return;
    }
    if (el.id === "exportBtn") { exportChecks(); return; }
    if (el.id === "logoutBtn") { logout(); return; }
  });

  document.addEventListener("submit", function (e) {
    if (e.target.id === "manual") { e.preventDefault(); resolve($("manualInput").value); $("manualInput").blur(); }
    if (e.target.id === "loginForm") { e.preventDefault(); login(); }
  });

  document.addEventListener("input", function (e) {
    if (e.target.id === "locSearch") $("locList").innerHTML = locRows(state.result[state.result.length - 1].code, e.target.value);
    if (e.target.id === "countIn") updateHint(state.parts[$("saveCheck").getAttribute("data-pn")]);
    if (e.target.id === "newLoc") {
      var v = normCode(e.target.value), pn = $("saveMove").getAttribute("data-pn");
      $("saveMove").disabled = !looksLoc(v) || v === state.parts[pn].lct_cd;
    }
  });
  document.addEventListener("change", function (e) {
    if (e.target.id === "optCam") { store.set("camera", e.target.checked); }
    if (e.target.id === "optSound") { store.set("sound", e.target.checked); }
  });

  // ---------- 동작 ----------
  async function saveCheck(pn) {
    var p = state.parts[pn], old = openChecksByItem()[pn];
    var v = parseFloat($("countIn").value), memo = $("memoIn").value.trim();
    $("saveCheck").disabled = true;
    var r;
    if (old) r = await sb.from("inv_checks").update({ counted_qty: v, memo: memo || null, dms_qty: p.crt_qty }).eq("id", old.id);
    else r = await sb.from("inv_checks").insert({ item_cd: pn, item_nm: p.item_nm, lct_cd: p.lct_cd, dms_qty: p.crt_qty, counted_qty: v, memo: memo || null, checked_by: state.user.id });
    if (r.error) { toast("저장하지 못했습니다: " + r.error.message); $("saveCheck").disabled = false; return; }
    await loadChecks();
    closeSheet(); render(false); toast("체크 기록에 저장했습니다");
  }
  async function clearCheck(id) {
    var r = await sb.from("inv_checks").update({ cleared_at: new Date().toISOString(), cleared_by_name: state.user.name }).eq("id", id);
    if (r.error) { toast("지우지 못했습니다: " + r.error.message); return; }
    await loadChecks();
    closeSheet(); render(false); toast("체크 기록을 지웠습니다");
  }

  async function saveMove(pn) {
    var to = normCode($("newLoc").value), from = state.parts[pn].lct_cd || "";
    $("saveMove").disabled = true;
    try {
      var id = await sendRequest("loc_change", pn, { from: from, to: to });
      state.moves[pn] = { from: from, to: to, status: "pending", reqId: id };
      closeSheet(); render(false);
      toast(daemonStale() ? "요청했습니다 · DMS 연결 PC가 응답하면 반영됩니다" : "DMS에 위치 변경을 요청했습니다");
      waitRequest(id, function (res) {
        if (res.status === "done") {
          state.moves[pn] = { from: from, to: to, status: "done", time: hhmm() };
          var p = state.parts[pn];
          if (p.lct_cd && state.locs[p.lct_cd]) state.locs[p.lct_cd] = state.locs[p.lct_cd].filter(function (k) { return k !== pn; });
          p.lct_cd = to; (state.locs[to] = state.locs[to] || []).push(pn);
          toast("DMS 반영 완료: " + (from || "공란") + " → " + to);
        } else {
          state.moves[pn] = { from: from, to: to, status: "failed", error: res.error };
          toast("위치 변경 실패: " + (res.error || ""));
        }
        if (state.tab === "scan") render(false);
      });
    } catch (e) {
      toast("요청하지 못했습니다: " + e.message);
    }
  }

  async function refreshPart(pn) {
    toast("DMS에서 현재고를 다시 조회합니다");
    try {
      var id = await sendRequest("stock", pn);
      waitRequest(id, function (res) {
        if (res.status !== "done") { toast("조회 실패: " + (res.error || "")); return; }
        var p = state.parts[pn], r = res.result;
        if (p && r.found) {
          if (p.lct_cd !== r.lct_cd) {
            if (p.lct_cd && state.locs[p.lct_cd]) state.locs[p.lct_cd] = state.locs[p.lct_cd].filter(function (k) { return k !== pn; });
            if (r.lct_cd) (state.locs[r.lct_cd] = state.locs[r.lct_cd] || []).push(pn);
          }
          p.crt_qty = r.crt_qty; p.lct_cd = r.lct_cd;
          state.rdc[pn] = { status: "done", result: r, at: Date.now() };
        }
        toast("현재고 " + qtyNum(r.crt_qty) + "개 · 위치 " + (r.lct_cd || "없음"));
        if (state.tab === "scan") render(false);
      });
    } catch (e) { toast("요청하지 못했습니다: " + e.message); }
  }

  async function lookupUnknown(pn, btn) {
    btn.disabled = true; btn.textContent = "DMS에서 조회 중…";
    try {
      var id = await sendRequest("stock", pn);
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
    await openAudit(state.auditOpen);
    toast("조사를 시작했습니다 · 목록 " + state.auditItems.length + "건 고정");
  }

  function exportChecks() {
    var rows = [["확인일시", "위치", "품번", "품명", "DMS 수량", "실사 수량", "차이", "확인자", "메모"]];
    state.checks.forEach(function (c) {
      var d = new Date(c.checked_at);
      rows.push([d.toLocaleString("ko-KR"), c.lct_cd || "", c.item_cd, c.item_nm || "", qtyNum(c.dms_qty), qtyNum(c.counted_qty), qtyNum(c.counted_qty - c.dms_qty), c.checked_by_name || "", c.memo || ""]);
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
      await Promise.all([loadStatus(), loadParts(), loadChecks(), loadAudits()]);
      lastPartsAt = state.status && state.status.parts_at;
    } catch (e) {
      toast("데이터를 불러오지 못했습니다: " + e.message);
    }
    state.loading = false;
    render(true);
    if (r.data.must_change_password) toast("비밀번호 변경이 필요합니다. 태블릿 앱에서 변경해 주세요.");
  }

  async function logout() {
    stopCamera();
    await sb.auth.signOut();
    state.user = null; state.result = []; state.tab = "scan"; state.parts = {}; state.locs = {}; state.checks = [];
    render(true);
  }

  // ---------- 시작 ----------
  (async function boot() {
    var s = await sb.auth.getSession();
    if (s.data && s.data.session) await afterLogin(s.data.session.user);
    else render(true);
    setInterval(function () { if (state.user && !state.loading) refreshStatus(); }, STATUS_POLL_MS);
  })();
})();
