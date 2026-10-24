/* DS재고 관리 — 옛 주소(GitHub Pages) 이전 안내
 *   앱 주소가 https://ds-inventory.pages.dev 로 바뀌었다. 주소가 바뀌면 휴대폰 저장 공간이 따로라서
 *   이 주소에 남은 "보내지 못한 재고조사 확인"(localStorage inv.auditOutbox)은 새 주소로 옮겨지지 않는다.
 *   그래서: 대기 건이 있으면 먼저 기존 앱(app.js 의 flushOutbox)이 보내게 두고, 다 빠지면 이동 안내를 띄운다.
 *   - 앱은 로그인돼 있으면 대기 건을 스스로 보낸다. 여기서는 몇 초마다 'online' 이벤트로 다시 보내기를 재촉만 한다.
 *   - 로그인이 풀려 있으면 로그인 화면 위에 "로그인하면 보냅니다" 를 띄운다.
 */
(function () {
  "use strict";
  var NEW_URL = "https://ds-inventory.pages.dev/";
  var POLL_MS = 3000;

  function get(k, d) { try { var v = localStorage.getItem("inv." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  var ua = navigator.userAgent;
  var android = /Android/i.test(ua), ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  // 안드로이드는 크롬에서 열어야 "홈 화면에 추가"가 됨 (홈 화면 앱 안에서 그냥 열면 작은 창으로 열림)
  var moveHref = android
    ? "intent://" + NEW_URL.replace(/^https:\/\//, "") + "#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=" + encodeURIComponent(NEW_URL) + ";end"
    : NEW_URL;

  var css = document.createElement("style");
  css.textContent =
    "#mgBanner{position:fixed;left:12px;right:12px;bottom:calc(84px + env(safe-area-inset-bottom));z-index:9998;background:#FF9500;color:#fff;border-radius:14px;padding:12px 14px;font:600 15px/1.45 -apple-system,system-ui,'Pretendard Variable',sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25)}" +
    "#mgBanner small{display:block;font-weight:500;opacity:.92;margin-top:2px}" +
    "#mgBanner button{margin-top:8px;background:rgba(255,255,255,.25);color:#fff;border:0;border-radius:9px;padding:7px 10px;font:inherit;font-size:13px}" +
    "#mgCover{position:fixed;inset:0;z-index:9999;overflow:auto;background:#F2F2F7;color:#1C1C1E;font:16px/1.55 -apple-system,system-ui,'Pretendard Variable',sans-serif;padding:calc(28px + env(safe-area-inset-top)) 20px calc(28px + env(safe-area-inset-bottom))}" +
    "#mgCover .box{max-width:460px;margin:0 auto}" +
    "#mgCover h1{font-size:24px;margin:0 0 6px}" +
    "#mgCover .url{display:block;font-weight:700;color:#007AFF;word-break:break-all;margin:4px 0 18px;font-size:18px}" +
    "#mgCover .go{display:block;text-align:center;background:#007AFF;color:#fff;text-decoration:none;font-weight:700;font-size:18px;border-radius:14px;padding:15px;margin:0 0 20px}" +
    "#mgCover .card{background:#fff;border-radius:14px;padding:14px 16px;margin:0 0 12px}" +
    "#mgCover .card>b{display:block;margin-bottom:4px}" +
    "#mgCover ol,#mgCover ul{margin:4px 0 0;padding-left:20px}" +
    "#mgCover .ok{color:#34C759;font-weight:700}" +
    "@media (prefers-color-scheme:dark){#mgCover{background:#17171C;color:#F2F2F7}#mgCover .card{background:#232329}#mgCover .url{color:#0A84FF}#mgCover .go{background:#0A84FF}}";
  document.head.appendChild(css);

  function steps() {
    if (ios) return "<ol><li>위 버튼으로 새 주소를 <b>사파리</b>에서 엽니다</li><li>아래 가운데 <b>공유</b> 버튼 → <b>홈 화면에 추가</b></li><li>옛 \"DS재고 관리\" 아이콘은 길게 눌러 삭제</li></ol>";
    return "<ol><li>위 버튼으로 새 주소를 <b>크롬</b>에서 엽니다</li><li>오른쪽 위 <b>⋮</b> → <b>홈 화면에 추가</b> (또는 <b>앱 설치</b>)</li><li>옛 \"DS재고 관리\" 아이콘은 길게 눌러 삭제</li></ol>";
  }

  function showCover(sentAny, skipped) {
    var b = document.getElementById("mgBanner"); if (b) b.remove();
    if (document.getElementById("mgCover")) return;
    var el = document.createElement("div");
    el.id = "mgCover";
    el.innerHTML = '<div class="box">' +
      "<h1>앱 주소가 바뀌었습니다</h1>" +
      "<div>DS재고 관리는 이제 아래 새 주소에서 씁니다. 이 주소는 곧 닫습니다.</div>" +
      '<span class="url">' + esc(NEW_URL.replace(/\/$/, "")) + "</span>" +
      '<a class="go" href="' + esc(moveHref) + '">새 주소로 이동</a>' +
      (skipped ? '<div class="card"><b>보내지 않은 조사 결과 ' + skipped + "건</b>보내지 않고 넘어갔습니다 (이 휴대폰의 옛 주소에 남아 있음). 새 주소에서 그 부품을 다시 확인해 주세요.</div>"
               : '<div class="card"><span class="ok">✓</span> ' + (sentAny ? "휴대폰에 남아 있던 재고조사 확인을 모두 보냈습니다." : "이 휴대폰에 보내지 못한 재고조사 확인이 없습니다.") + "</div>") +
      '<div class="card"><b>홈 화면에 다시 추가해 주세요</b>' + steps() + "</div>" +
      '<div class="card"><b>새 주소에서 처음 한 번</b><ul><li>다시 로그인합니다 (같은 아이디·비밀번호)</li><li>설정(카메라·소리·화면 모드)과 최근 스캔 목록은 처음 상태로 돌아갑니다</li></ul></div>' +
      "</div>";
    document.body.appendChild(el);
  }

  var SKIP = '<button id="mgSkip">보내지 않고 새 주소 안내 보기</button>';
  function showBanner(mine, others, loggedIn) {
    var b = document.getElementById("mgBanner");
    if (!b) { b = document.createElement("div"); b.id = "mgBanner"; document.body.appendChild(b); }
    var html, total = mine + others;
    if (mine && loggedIn) html = "보내지 못한 재고조사 확인 " + mine + "건을 보내는 중입니다…<small>앱 주소가 바뀌어 먼저 보내야 합니다. 인터넷이 되는 곳에서 잠시 기다려 주세요.</small>";
    else if (!loggedIn) html = "보내지 못한 재고조사 확인 " + total + "건이 있습니다<small>앱 주소가 바뀌었습니다. 로그인하면 먼저 보낸 뒤 새 주소를 알려 드립니다.</small>" + SKIP;
    else html = "다른 계정으로 저장된 재고조사 확인 " + others + "건이 남아 있습니다<small>그 계정으로 로그인하면 보냅니다 (설정 → 로그아웃 후 다시 로그인).</small>" + SKIP;
    if (b.getAttribute("data-h") !== html) {
      b.innerHTML = html; b.setAttribute("data-h", html);
      var s = document.getElementById("mgSkip");
      if (s) s.onclick = function () {
        if (confirm("보내지 못한 조사 결과 " + total + "건은 보내지 않고 이 휴대폰에 남습니다. 새 주소에서 그 부품을 다시 확인해야 합니다. 계속할까요?")) { skipped = total; showCover(sentAny, total); }
      };
    }
  }

  var sentAny = false, skipped = 0, lastNudge = 0;
  function tick() {
    if (document.getElementById("mgCover")) return;
    var box = get("auditOutbox", []);
    if (!Array.isArray(box)) box = [];
    var uid = get("lastUser", null), loggedIn = false;
    try { loggedIn = !!uid && !!localStorage.getItem("inventory-scan-auth"); } catch (e) { /* 저장소를 못 읽으면 로그인 안 된 것으로 */ }
    var mine = box.filter(function (j) { return uid && j && j.userId === uid; }).length;
    var others = box.length - mine;
    if (!box.length) { showCover(sentAny, 0); return; }
    sentAny = true;   // 대기 건이 있었음 → 다 빠지면 "모두 보냈습니다"
    showBanner(mine, others, loggedIn);
    // 앱의 보내기(flushOutbox)를 재촉 — 앱은 'online' 이벤트에 다시 보냄
    if (mine && loggedIn && navigator.onLine && Date.now() - lastNudge > POLL_MS) { lastNudge = Date.now(); window.dispatchEvent(new Event("online")); }
  }
  function start() { tick(); setInterval(tick, 1000); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
