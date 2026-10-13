/* 재고조사 보고서: A4 세로 시트 → 이미지 PDF → 공유 메뉴(OneDrive 등) / 내려받기
 *
 * 태블릿 입출고 앱(dsm-tablet-app lib/pdfShare.ts)과 같은 방식:
 *  - 안드로이드는 인쇄 화면의 "PDF로 저장"에서 OneDrive 를 고를 수 없고 OneDrive 는 공유로만 받으므로
 *    쪽마다 그림으로 찍어(약 145dpi, JPEG 78%) PDF 한 파일로 묶어 공유 메뉴로 보낸다. 글자 검색은 안 되지만 모양은 미리보기와 같다.
 *  - Chrome 은 버튼을 누른 직후(약 5초)에만 공유 메뉴를 열어 주므로, 미리보기를 열 때 PDF 를 미리 만들어 둔다 (app.js).
 *  - 표는 줄 단위로 쪽을 나누고(줄 중간을 자르지 않음) 쪽마다 머리글을 반복, 쪽 아래에 소속 문구와 쪽 번호.
 *
 * 보고서 양식은 아래 "보고서 양식" 부분(CSS, blocks)만 바꾸면 된다. 쪽 나누기·PDF·공유는 그대로 쓴다.
 */
(function () {
  "use strict";

  var JSPDF_URL = "https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js";   // 태블릿 앱과 같은 버전
  var FOOTER = "동성모터스 파트실 전용 · 무단 배포 금지";
  var PAGE = { w: 210, h: 297, margin: 14, foot: 8 };   // mm: 용지, 여백, 쪽 아래 문구 자리
  var PX_PER_MM = 96 / 25.4;
  var PIXEL_RATIO = 1.5, JPEG_QUALITY = 0.78;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function num(v) { var n = Number(v); return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100); }
  function ymdhm(d) {
    if (!d) return "-";
    d = new Date(d);
    var p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  // ============================================================
  // 보고서 양식 (여기만 바꾸면 됨)
  // ============================================================
  var CSS = [
    // 종이: 먹색 글자, 가는 선, 얇은 회색만 씀 (색 면·둥근 상자 없음)
    ".rp-page{box-sizing:border-box;position:relative;width:210mm;height:297mm;padding:14mm 14mm 16mm;background:#fff;color:#1b1f2a;overflow:hidden;color-scheme:only light;forced-color-adjust:none;",
    "font-family:-apple-system,'Noto Sans KR','Noto Sans CJK KR','Apple SD Gothic Neo','Malgun Gothic',sans-serif;font-size:8.5pt;line-height:1.4}",
    ".rp-page *{box-sizing:border-box}",
    ".rp-foot{position:absolute;left:14mm;right:14mm;bottom:8mm;display:flex;justify-content:space-between;padding-top:1.6mm;border-top:.5px solid #c9ccd2;font-size:7pt;color:#8a8f98;line-height:1;letter-spacing:.02em}",
    // 머리: 소속 → 제목 → 기간, 오른쪽에 결재란, 아래에 이중선
    ".rp-top{display:flex;justify-content:space-between;align-items:flex-end;gap:6mm;margin:0 0 4mm}",
    ".rp-eyebrow{font-size:8pt;color:#6b7280;letter-spacing:.14em;margin:0 0 2.2mm}",
    ".rp-title{font-size:20pt;font-weight:700;letter-spacing:.02em;line-height:1.15;margin:0}",
    ".rp-sub{color:#6b7280;font-size:9pt;margin:2mm 0 0}",
    ".rp-sign{display:flex;flex:none}",
    ".rp-sign div{width:19mm;border:.5px solid #9aa0aa;text-align:center}",
    ".rp-sign div+div{border-left:0}",
    ".rp-sign span{display:block;padding:1.2mm 0;font-size:7.5pt;color:#6b7280;letter-spacing:.2em;border-bottom:.5px solid #9aa0aa}",
    ".rp-sign i{display:block;height:11.5mm}",
    ".rp-rule{height:1mm;border-top:1.6px solid #1b1f2a;border-bottom:.5px solid #1b1f2a;margin:0 0 3.5mm}",
    // 일시: 이름표를 위에 작게, 값은 아래에
    ".rp-meta{display:flex;margin:0 0 4mm}",
    ".rp-meta div{flex:1}",
    ".rp-meta span{display:block;font-size:7.5pt;color:#8a8f98;letter-spacing:.06em;margin:0 0 .8mm}",
    ".rp-meta b{font-weight:500;font-size:9pt;font-variant-numeric:tabular-nums}",
    // 요약: 큰 숫자 네 개를 가는 세로선으로 나눔
    ".rp-sum{display:flex;border-top:.5px solid #c9ccd2;border-bottom:.5px solid #c9ccd2;margin:0 0 2mm}",
    ".rp-sum div{flex:1;text-align:center;padding:3mm 0 2.6mm}",
    ".rp-sum div+div{border-left:.5px solid #c9ccd2}",
    ".rp-sum b{display:block;font-size:19pt;font-weight:600;line-height:1.1;font-variant-numeric:tabular-nums}",
    ".rp-sum span{display:block;margin-top:1mm;font-size:7.5pt;color:#6b7280;letter-spacing:.12em}",
    ".rp-sum .w b{color:#8c2f39}",
    // 구역 제목
    ".rp-h{display:flex;align-items:baseline;gap:2mm;margin:5mm 0 0;padding:0 0 1.3mm;border-bottom:1px solid #1b1f2a;font-size:10.5pt;font-weight:700;letter-spacing:.03em}",
    ".rp-h em{font-style:normal;font-weight:500;font-size:8.5pt;color:#6b7280;letter-spacing:0}",
    ".rp-hn{margin-left:auto;font-size:7pt;font-weight:400;color:#8a8f98;letter-spacing:0}",
    // 표: 세로선 없이 가는 가로선, 머리글은 작게 가운데
    ".rp-list{width:100%;border-collapse:collapse;table-layout:fixed;margin:0 0 1mm}",
    ".rp-list th{padding:1.8mm 1.2mm 1.4mm;border-bottom:.5px solid #9aa0aa;font-size:7.5pt;font-weight:600;color:#6b7280;letter-spacing:.06em;text-align:center;white-space:nowrap}",
    ".rp-list td{padding:1.45mm 1.2mm;text-align:center;vertical-align:middle;border-bottom:.5px solid #e3e5e9;overflow-wrap:anywhere;word-break:keep-all}",
    ".rp-list td.k{white-space:nowrap;overflow-wrap:normal;word-break:normal}",
    ".rp-list .m{font-family:'SF Mono',ui-monospace,Menlo,Consolas,'Roboto Mono',monospace;font-size:.94em;letter-spacing:-.01em}",
    ".rp-list .n{font-variant-numeric:tabular-nums}",
    ".rp-list .neg{color:#8c2f39;font-weight:700}",
    ".rp-list .pos{color:#1f4f8a;font-weight:700}",
    ".rp-list .l{text-align:left}",
    ".rp-list tr.mm td{padding:0;border-bottom:0}",
    ".rp-list tr.mm td div{margin:.2mm 0 0;padding:2mm 3mm 2.1mm 3.4mm;background:#f6f3ef;border-left:.9mm solid #8c2f39;text-align:left;font-size:8.5pt;line-height:1.55;color:#1b1f2a;white-space:pre-wrap;overflow-wrap:anywhere;word-break:keep-all}",
    ".rp-list tr.mm td b{display:inline-block;margin-right:2.4mm;padding:.4mm 1.9mm;background:#8c2f39;color:#fff;font-size:7pt;font-weight:600;letter-spacing:.14em;border-radius:.6mm;vertical-align:.3mm}",
    ".rp-list tr.has td{padding-bottom:1.2mm}",
    ".rp-list tbody.g td{border-bottom:0}",
    ".rp-list tbody.g tr.last td{border-bottom:.5px solid #e3e5e9}",
    ".rp-list tbody.g tr.sp td{height:2.6mm;padding:0}",
    ".rp-list.sm{font-size:7.5pt}",
    ".rp-list.sm th{font-size:7pt}",
    ".rp-list.sm td{padding:1.4mm .8mm;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;overflow-wrap:normal;word-break:normal}",
    ".rp-list td.e{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;overflow-wrap:normal;word-break:normal}",
    ".rp-list.wk td.l{text-align:left;padding-left:3mm}",
    ".rp-list.wk td.bar{text-align:left;white-space:nowrap}",
    ".rp-bar{display:inline-block;vertical-align:middle;width:34mm;height:1.9mm;background:#e9ebef;border-radius:1mm;overflow:hidden}",
    ".rp-bar i{display:block;height:100%;background:#1b1f2a}",
    ".rp-pct{display:inline-block;width:9mm;text-align:right;margin-left:2mm;font-variant-numeric:tabular-nums;color:#4b5160}",
    ".rp-list tr.tot td{font-weight:700;border-bottom:0;border-top:.5px solid #9aa0aa}",
    ".rp-list.ex{font-size:8pt}",
    ".rp-list.ex td.l,.rp-list.ex th:last-child{text-align:left;padding-left:3mm}",
    ".rp-list .t{white-space:nowrap;font-variant-numeric:tabular-nums;overflow-wrap:normal}",
    ".rp-none{color:#6b7280;padding:4.5mm 0;text-align:center;border-bottom:.5px solid #e3e5e9}"
  ].join("");

  // 걸린 시간: 재고 확인 창을 연 때 → 확인 누름 (45초 / 3분 12초 / 1시간 5분). 창 연 시각이 없는 옛 기록은 '-'
  function elapsed(from, to) {
    if (!from || !to) return "-";
    var s = Math.round((new Date(to) - new Date(from)) / 1000);
    if (!(s >= 0)) return "-";
    if (s < 60) return s + "초";
    if (s < 3600) return Math.floor(s / 60) + "분" + (s % 60 ? " " + (s % 60) + "초" : "");
    return Math.floor(s / 3600) + "시간" + (Math.floor(s % 3600 / 60) ? " " + Math.floor(s % 3600 / 60) + "분" : "");
  }
  function hm(d) {   // 14:02 (날짜 없이)
    if (!d) return "-";
    d = new Date(d);
    var p = function (n) { return String(n).padStart(2, "0"); };
    return p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function hms(d) {   // 14:02:33 (날짜 없이)
    if (!d) return "-";
    d = new Date(d);
    var p = function (n) { return String(n).padStart(2, "0"); };
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  /**
   * 보고서 내용을 블록 목록으로 만든다. 블록은 그대로 놓이고, 표({head, rows})는 줄 단위로 쪽을 나눈다.
   * 표의 rows 가 <tbody>…</tbody> 문자열이면 그 묶음(품목 줄 + 메모 줄)을 한 덩어리로 보고 나눈다.
   * d: {title, branch, period, started_at, started_by, finished_at, finished_by, printed_at,
   *     total, ok, diff, left, diffItems[{lct_cd,item_cd,item_nm,qty,rr,counted,by,memo}], leftItems[{lct_cd,item_cd,item_nm,qty,rr}],
   *     doneItems[{lct_cd,item_cd,item_nm,qty,rr,counted,status,via,scanned_at,marked_at,opened_at,by}] (확인한 부품 전부, opened_at = 확인 창을 연 시각),
   *     removedItems[{lct_cd,item_cd,item_nm,qty,rr,at,by}] (DMS 갱신 때 재고 0으로 뺀 부품)}
   *   qty = BMW(DMS) 수량, rr = RR 수량. 차이 = 실사 - (BMW + RR)
   */
  function blocks(d) {
    var out = [];
    var who = function (t, n) { return ymdhm(t) + (n ? " · " + esc(n) : ""); };
    out.push({ html: '<div class="rp-top"><div><div class="rp-eyebrow">동성모터스 · ' + esc(d.branch) + '</div><h1 class="rp-title">' + esc(d.title) + '</h1><p class="rp-sub">' + esc(d.period) + '</p></div>' +
      '<div class="rp-sign"><div><span>담당</span><i></i></div><div><span>확인</span><i></i></div><div><span>승인</span><i></i></div></div></div><div class="rp-rule"></div>' });
    out.push({ html: '<div class="rp-meta"><div><span>조사 시작</span><b>' + who(d.started_at, d.started_by) + '</b></div>' +
      '<div><span>조사 종료</span><b>' + who(d.finished_at, d.finished_by) + '</b></div>' +
      '<div><span>출력 일시</span><b>' + ymdhm(d.printed_at) + '</b></div></div>' });
    out.push({ html: '<div class="rp-sum"><div><b>' + d.total + '</b><span>조사 대상</span></div><div><b>' + d.ok + '</b><span>일치</span></div>' +
      '<div class="' + (d.diff ? "w" : "") + '"><b>' + d.diff + '</b><span>수량 다름</span></div><div class="' + (d.left ? "w" : "") + '"><b>' + d.left + '</b><span>미확인</span></div></div>' });

    // 작업자별 확인: 여러 명이 나눠서 조사할 때 누가 몇 건 확인했는지
    var dn = d.doneItems || [], wk = {};
    dn.forEach(function (it) {
      var w = wk[it.by || "(미상)"] = wk[it.by || "(미상)"] || { n: it.by || "(미상)", c: 0, ok: 0, diff: 0, first: 0, last: 0 };
      w.c++; if (it.status === "ok") w.ok++; else w.diff++;
      var t = it.marked_at ? Date.parse(it.marked_at) : 0;
      if (t) { if (!w.first || t < w.first) w.first = t; if (t > w.last) w.last = t; }
    });
    var wl = Object.keys(wk).map(function (k) { return wk[k]; }).sort(function (x, y) { return y.c - x.c || x.n.localeCompare(y.n); });
    if (wl.length) {
      out.push({ keep: true, html: '<h2 class="rp-h">작업자별 확인<em>' + wl.length + '명</em></h2>' });
      out.push({ table: {
        cls: "wk",
        head: '<colgroup><col style="width:34mm"><col style="width:20mm"><col style="width:20mm"><col style="width:22mm"><col><col style="width:34mm"></colgroup>' +
          '<thead><tr><th>작업자</th><th>확인</th><th>일치</th><th>수량 다름</th><th>비율</th><th>작업 시간</th></tr></thead>',
        rows: wl.map(function (w) {
          var pc = Math.round(w.c / dn.length * 100);
          return '<tr><td class="l"><b>' + esc(w.n) + '</b></td><td class="n">' + w.c + '건</td><td class="n">' + w.ok + '</td><td class="n' + (w.diff ? ' neg' : '') + '">' + w.diff + '</td>' +
            '<td class="bar"><span class="rp-bar"><i style="width:' + pc + '%"></i></span><span class="rp-pct">' + pc + '%</span></td>' +
            '<td class="t">' + (w.first ? hm(w.first) + ' ~ ' + hm(w.last) : '-') + '</td></tr>';
        }).concat(wl.length > 1 ? ['<tr class="tot"><td class="l">합계</td><td class="n">' + dn.length + '건</td><td class="n">' + wl.reduce(function (a, w) { return a + w.ok; }, 0) + '</td><td class="n">' + wl.reduce(function (a, w) { return a + w.diff; }, 0) + '</td><td></td><td></td></tr>'] : [])
      } });
    }

    out.push({ keep: true, html: '<h2 class="rp-h">수량 다름<em>' + d.diffItems.length + '건</em></h2>' });
    if (d.diffItems.length) {
      out.push({ table: {
        head: '<colgroup><col style="width:19mm"><col style="width:29mm"><col><col style="width:12mm"><col style="width:12mm"><col style="width:13mm"><col style="width:13mm"><col style="width:17mm"></colgroup>' +
          '<thead><tr><th>위치</th><th>품번</th><th>품명</th><th>BMW</th><th>RR</th><th>실사</th><th>차이</th><th>확인자</th></tr></thead>',
        rows: d.diffItems.map(function (it) {
          var df = Number(it.counted) - Number(it.qty) - (Number(it.rr) || 0);   // 차이 = 실사 - (BMW + RR)
          // 메모는 품목 줄 아래 한 줄 전체를 써서 길어도 품번이 잘리지 않음
          return '<tbody class="g"><tr class="' + (it.memo ? 'has' : 'last') + '"><td class="m k">' + esc(it.lct_cd || "-") + '</td><td class="m k">' + esc(it.item_cd) + '</td><td>' + esc(it.item_nm) + '</td>' +
            '<td class="n">' + num(it.qty) + '</td><td class="n">' + num(it.rr || 0) + '</td><td class="n">' + num(it.counted) + '</td><td class="n ' + (df < 0 ? "neg" : "pos") + '">' + (df > 0 ? "+" : "") + num(df) + '</td>' +
            '<td>' + esc(it.by || "") + '</td></tr>' +
            (it.memo ? '<tr class="mm"><td colspan="8"><div><b>메모</b>' + esc(it.memo) + '</div></td></tr><tr class="sp last"><td colspan="8"></td></tr>' : '') + '</tbody>';
        })
      } });
    } else out.push({ html: '<div class="rp-none">수량이 다른 부품이 없습니다</div>' });

    out.push({ keep: true, html: '<h2 class="rp-h">미확인<em>' + d.leftItems.length + '건</em></h2>' });
    if (d.leftItems.length) {
      out.push({ table: {
        head: '<colgroup><col style="width:23mm"><col style="width:34mm"><col><col style="width:15mm"><col style="width:15mm"><col style="width:15mm"></colgroup>' +
          '<thead><tr><th>위치</th><th>품번</th><th>품명</th><th>BMW</th><th>RR</th><th>합계</th></tr></thead>',
        rows: d.leftItems.map(function (it) {
          return '<tr><td class="m k">' + esc(it.lct_cd || "-") + '</td><td class="m k">' + esc(it.item_cd) + '</td><td class="e">' + esc(it.item_nm) + '</td><td class="n">' + num(it.qty) + '</td><td class="n">' + num(it.rr || 0) + '</td><td class="n">' + num(Number(it.qty) + (Number(it.rr) || 0)) + '</td></tr>';
        })
      } });
    } else out.push({ html: '<div class="rp-none">모두 확인했습니다</div>' });

    // 확인 내역: 확인한 부품 전부(일치 포함) — 어떤 방식으로 언제 스캔하고 누가 확인했는지, 스캔에서 확인까지 걸린 시간
    // 줄 높이가 들쭉날쭉하지 않게 모든 칸을 한 줄로 두고(넘치면 …), 길어지는 예외 사유는 표 아래에 따로 적는다
    if (dn.length) {
      out.push({ keep: true, html: '<h2 class="rp-h">확인 내역<em>' + dn.length + '건</em><span class="rp-hn">스캔 = 위치·부품 바코드를 찍은 시각 · 확인 = 일치/수량 다름을 누른 시각 · 걸린시간 = 재고 확인 창을 연 때부터 확인까지</span></h2>' });
      out.push({ table: {
        cls: "sm",
        head: '<colgroup><col style="width:16mm"><col style="width:23mm"><col><col style="width:10mm"><col style="width:14mm"><col style="width:19mm"><col style="width:15mm"><col style="width:15mm"><col style="width:16mm"><col style="width:15mm"></colgroup>' +
          '<thead><tr><th>위치</th><th>품번</th><th>품명</th><th>수량</th><th>결과</th><th>방식</th><th>스캔</th><th>확인</th><th>걸린시간</th><th>작업자</th></tr></thead>',
        rows: dn.map(function (it) {
          return '<tr><td class="m k">' + esc(it.lct_cd || "-") + '</td><td class="m k">' + esc(it.item_cd) + '</td><td>' + esc(it.item_nm) + '</td>' +
            '<td class="n">' + num(Number(it.qty) + (Number(it.rr) || 0)) + '</td>' +
            '<td' + (it.status === "ok" ? '>일치' : ' class="neg">다름 ' + num(it.counted)) + '</td>' +
            '<td>' + esc(it.via) + '</td><td class="t">' + hms(it.scanned_at) + '</td><td class="t">' + hms(it.marked_at) + '</td><td class="t">' + elapsed(it.opened_at, it.marked_at) + '</td><td>' + esc(it.by || "") + '</td></tr>';
        })
      } });
      // 예외로 확인한 건은 사유를 따로 표로 (확인 내역 표는 한 줄로 두기 위해)
      var ex = dn.filter(function (it) { return it.reason; });
      if (ex.length) {
        out.push({ keep: true, html: '<h2 class="rp-h">예외 확인<em>' + ex.length + '건</em><span class="rp-hn">위치·부품 바코드를 스캔하지 못해 사유를 적고 확인한 부품</span></h2>' });
        out.push({ table: {
          cls: "ex",
          head: '<colgroup><col style="width:19mm"><col style="width:28mm"><col style="width:46mm"><col style="width:18mm"><col></colgroup>' +
            '<thead><tr><th>위치</th><th>품번</th><th>품명</th><th>작업자</th><th>사유</th></tr></thead>',
          rows: ex.map(function (it) {
            return '<tr><td class="m k">' + esc(it.lct_cd || "-") + '</td><td class="m k">' + esc(it.item_cd) + '</td><td class="e">' + esc(it.item_nm) + '</td><td>' + esc(it.by || "") + '</td><td class="l">' + esc(it.reason) + '</td></tr>';
          })
        } });
      }
    }

    return out;
  }

  // ============================================================
  // 쪽 나누기: 실제 A4 폭으로 화면 밖에 그려 높이를 잰다
  // ============================================================
  var styleEl = null;
  function ensureStyle() {
    if (styleEl) return;
    styleEl = document.createElement("style");
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  }

  /** 블록들을 쪽(HTML 문자열 배열)으로 나눈다 */
  function paginate(list) {
    ensureStyle();
    var contentH = (PAGE.h - PAGE.margin - 16) * PX_PER_MM;   // .rp-page 위 여백 14mm, 아래 16mm(쪽 아래 문구 자리 포함)
    var probe = document.createElement("div");
    probe.className = "rp-page";
    Object.assign(probe.style, { position: "fixed", left: "-20000px", top: "0", height: "auto", overflow: "visible" });
    document.body.appendChild(probe);
    var pages = [], cur = "", used = 0, held = null;   // held: 다음 블록과 같은 쪽에 놓아야 하는 제목
    var flush = function () { if (cur) pages.push(cur); cur = ""; used = 0; };
    // 블록 하나를 단독으로 그렸을 때 차지하는 높이 (바깥 여백 포함: 위아래에 기준 선을 두고 잰다)
    var measure = function (html) {
      probe.innerHTML = '<div style="height:0"></div>' + html + '<div style="height:0"></div>';
      var k = probe.children;
      return k[k.length - 1].getBoundingClientRect().top - k[0].getBoundingClientRect().bottom;
    };
    try {
      var takeHeld = function () { if (held) { cur += held.html; used += held.h; held = null; } };
      list.forEach(function (b) {
        if (b.keep) { held = { html: b.html, h: measure(b.html) }; return; }
        var lead = held ? held.h : 0;
        if (!b.table) {
          var h = measure(b.html);
          if (used + lead + h > contentH && cur) flush();
          takeHeld();
          cur += b.html; used += h;
          return;
        }
        // 표: 머리글 높이와 줄마다 높이를 한 번에 잰다
        var tcls = "rp-list" + (b.table.cls ? " " + b.table.cls : "");
        var grouped = b.table.rows.length && b.table.rows[0].indexOf('<tbody') === 0;   // 품목 줄 + 메모 줄을 한 묶음(<tbody>)으로 나눔
        var wrap = function (rows) { return grouped ? rows.join('') : '<tbody>' + rows.join('') + '</tbody>'; };
        probe.innerHTML = '<table class="' + tcls + '">' + b.table.head + wrap(b.table.rows) + '</table>';
        var t = probe.firstChild, headH = t.tHead.getBoundingClientRect().height;
        var rowH = [].map.call(grouped ? t.tBodies : t.tBodies[0].rows, function (r) { return r.getBoundingClientRect().height; });
        var seg = [];
        var close = function () { if (seg.length) cur += '<table class="' + tcls + '">' + b.table.head + wrap(seg) + '</table>'; seg = []; };
        // 작은 표(약 70mm 이하)는 쪼개지 않고 통째로 한 쪽에, 긴 표는 머리글 + 2줄이 들어갈 때 이 쪽에서 시작
        var total = rowH.reduce(function (a, x) { return a + x; }, headH);
        var need = total <= 70 * PX_PER_MM ? total : headH + (rowH[0] || 0) + (rowH[1] || 0);
        if (cur && used + lead + need > contentH) flush();
        takeHeld();
        used += headH;
        b.table.rows.forEach(function (r, i) {
          if (used + rowH[i] > contentH && seg.length) {
            // 마지막 한 줄만 넘어가면 앞 줄 하나를 같이 넘겨 한 줄짜리 쪽이 생기지 않게 함
            var carry = (i === b.table.rows.length - 1 && seg.length >= 3) ? seg.pop() : null;
            close(); flush(); used = headH;   // 다음 쪽에서 머리글 반복
            if (carry) { seg.push(carry); used += rowH[i - 1]; }
          }
          seg.push(r); used += rowH[i];
        });
        close();
      });
      takeHeld();
      flush();
    } finally {
      probe.remove();
    }
    return pages.map(function (html, i) {
      return '<div class="rp-page">' + html + '<div class="rp-foot"><span>' + FOOTER + '</span><span>' + (i + 1) + ' / ' + pages.length + '</span></div></div>';
    });
  }

  // ============================================================
  // PDF: 쪽마다 SVG(foreignObject) 그림 → 캔버스 → JPEG → jsPDF
  // ============================================================
  var jspdfPromise = null;
  function loadJsPdf() {
    if (window.jspdf) return Promise.resolve(window.jspdf);
    if (!jspdfPromise) {
      jspdfPromise = new Promise(function (ok, fail) {
        var s = document.createElement("script");
        s.src = JSPDF_URL;
        s.onload = function () { window.jspdf ? ok(window.jspdf) : fail(new Error("PDF 도구를 불러오지 못했습니다")); };
        s.onerror = function () { jspdfPromise = null; fail(new Error("PDF 도구를 불러오지 못했습니다 (인터넷 연결 확인)")); };
        document.head.appendChild(s);
      });
    }
    return jspdfPromise;
  }

  async function pageToCanvas(html) {
    var w = Math.round(PAGE.w * PX_PER_MM), h = Math.round(PAGE.h * PX_PER_MM);
    var holder = document.createElement("div");
    holder.innerHTML = html;
    var xhtml = new XMLSerializer().serializeToString(holder.firstChild);   // <br> 등을 그림 안에서 읽을 수 있는 형식으로
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '"><foreignObject x="0" y="0" width="100%" height="100%">' +
      '<div xmlns="http://www.w3.org/1999/xhtml"><style>' + CSS.replace(/</g, "&lt;") + '</style>' + xhtml + '</div></foreignObject></svg>';
    var img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);   // blob: 주소는 캔버스를 막아 JPEG 로 못 꺼냄
    await img.decode();
    var canvas = document.createElement("canvas");
    canvas.width = Math.floor(w * PIXEL_RATIO);
    canvas.height = Math.floor(h * PIXEL_RATIO);
    var g = canvas.getContext("2d");
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /** 쪽 HTML 들로 PDF 파일을 만든다 */
  async function buildPdf(pages, fileTitle, onProgress) {
    var lib = await loadJsPdf();
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    var pdf = new lib.jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
    for (var i = 0; i < pages.length; i++) {
      if (onProgress) onProgress(i + 1, pages.length);
      var canvas = await pageToCanvas(pages[i]);
      if (i > 0) pdf.addPage("a4", "portrait");
      pdf.addImage(canvas.toDataURL("image/jpeg", JPEG_QUALITY), "JPEG", 0, 0, PAGE.w, PAGE.h, undefined, "FAST");
    }
    return new File([pdf.output("blob")], fileTitle + ".pdf", { type: "application/pdf" });
  }

  /**
   * 공유 메뉴로 보낸다 (안드로이드: OneDrive·메일·메신저 등). 버튼을 누른 그 순간에 불러야 열린다.
   * 결과: {status: "shared" | "cancelled" | "blocked" | "unsupported", error: 브라우저가 준 오류 (원인 확인용)}
   * 파일만 보낸다 (제목을 같이 넣으면 거절하는 브라우저가 있음)
   */
  async function shareFile(file) {
    if (!navigator.share || !navigator.canShare || !navigator.canShare({ files: [file] })) return { status: "unsupported", error: "" };
    try {
      await navigator.share({ files: [file] });
      return { status: "shared", error: "" };
    } catch (e) {
      var err = (e && e.name ? e.name : "Error") + (e && e.message ? ": " + e.message : "");
      return { status: e && e.name === "AbortError" ? "cancelled" : "blocked", error: err };
    }
  }

  /** 다운로드 폴더에 내려받기 (공유 메뉴를 쓸 수 없는 기기용) */
  function downloadFile(file) {
    var url = URL.createObjectURL(file);
    var a = document.createElement("a");
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  window.AuditReport = {
    /** 보고서 데이터 → 쪽 HTML 배열 (미리보기와 PDF 가 같은 것을 씀) */
    pages: function (d) { return paginate(blocks(d)); },
    buildPdf: buildPdf,
    shareFile: shareFile,
    downloadFile: downloadFile
  };
})();
