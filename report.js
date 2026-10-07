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
  var PAGE = { w: 210, h: 297, margin: 12, foot: 8 };   // mm: 용지, 여백, 쪽 아래 문구 자리
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
    ".rp-page{box-sizing:border-box;position:relative;width:210mm;height:297mm;padding:12mm 12mm 20mm;background:#fff;color:#111;overflow:hidden;",
    "font-family:-apple-system,'Noto Sans KR','Noto Sans CJK KR','Apple SD Gothic Neo','Malgun Gothic',sans-serif;font-size:9pt;line-height:1.35}",
    ".rp-page *{box-sizing:border-box}",
    ".rp-foot{position:absolute;left:0;right:0;bottom:7mm;text-align:center;font-size:7pt;color:#999;line-height:1}",
    ".rp-title{font-size:17pt;font-weight:700;margin:0 0 1mm}",
    ".rp-sub{color:#555;margin:0 0 5mm}",
    ".rp-info{width:100%;border-collapse:collapse;margin:0 0 5mm}",
    ".rp-info td{border:1px solid #bbb;padding:1.6mm 2.4mm}",
    ".rp-info td.l{background:#f2f3f5;width:22mm;color:#444}",
    ".rp-sum{display:flex;gap:3mm;margin:0 0 6mm}",
    ".rp-sum div{flex:1;border:1px solid #bbb;border-radius:2mm;padding:2.5mm 3mm}",
    ".rp-sum b{display:block;font-size:16pt;line-height:1.1}",
    ".rp-sum span{color:#555}",
    ".rp-sum .w b{color:#c0392b}",
    ".rp-h{font-size:11pt;font-weight:700;margin:5mm 0 2mm}",
    ".rp-list{width:100%;border-collapse:collapse;table-layout:fixed}",
    ".rp-list th{background:#f2f3f5;border:1px solid #bbb;padding:1.4mm 1.6mm;font-weight:600;text-align:left}",
    ".rp-list td{border:1px solid #bbb;padding:1.4mm 1.6mm;vertical-align:top;word-break:break-all}",
    ".rp-list .n{text-align:right;font-variant-numeric:tabular-nums}",
    ".rp-list .m{font-family:'SF Mono',ui-monospace,Menlo,Consolas,'Roboto Mono',monospace}",
    ".rp-list .neg{color:#c0392b;font-weight:700}",
    ".rp-list .pos{color:#1f6fd1;font-weight:700}",
    ".rp-none{color:#666;border:1px dashed #bbb;padding:3mm;text-align:center}",
    ".rp-sign{display:flex;justify-content:flex-end;gap:0;margin-top:8mm}",
    ".rp-sign div{width:26mm;border:1px solid #bbb;text-align:center}",
    ".rp-sign div+div{border-left:0}",
    ".rp-sign span{display:block;background:#f2f3f5;border-bottom:1px solid #bbb;padding:1mm 0}",
    ".rp-sign i{display:block;height:16mm}"
  ].join("");

  /**
   * 보고서 내용을 블록 목록으로 만든다. 블록은 그대로 놓이고, 표({head, rows})는 줄 단위로 쪽을 나눈다.
   * d: {title, branch, period, started_at, started_by, finished_at, finished_by, printed_at,
   *     total, ok, diff, left, diffItems[{lct_cd,item_cd,item_nm,qty,counted,by,memo}], leftItems[{lct_cd,item_cd,item_nm,qty}]}
   */
  function blocks(d) {
    var out = [];
    out.push({ html: '<h1 class="rp-title">' + esc(d.title) + '</h1><p class="rp-sub">' + esc(d.branch) + ' · ' + esc(d.period) + '</p>' });
    out.push({ html: '<table class="rp-info"><tr><td class="l">조사 시작</td><td>' + ymdhm(d.started_at) + ' · ' + esc(d.started_by || "") + '</td>' +
      '<td class="l">조사 종료</td><td>' + ymdhm(d.finished_at) + ' · ' + esc(d.finished_by || "") + '</td></tr>' +
      '<tr><td class="l">출력일시</td><td colspan="3">' + ymdhm(d.printed_at) + '</td></tr></table>' });
    out.push({ html: '<div class="rp-sum"><div><b>' + d.total + '</b><span>조사 대상</span></div><div><b>' + d.ok + '</b><span>일치</span></div>' +
      '<div class="' + (d.diff ? "w" : "") + '"><b>' + d.diff + '</b><span>수량 다름</span></div><div class="' + (d.left ? "w" : "") + '"><b>' + d.left + '</b><span>미확인</span></div></div>' });

    out.push({ html: '<h2 class="rp-h">수량 다름 ' + d.diffItems.length + '건</h2>' });
    if (d.diffItems.length) {
      out.push({ table: {
        head: '<colgroup><col style="width:19mm"><col style="width:27mm"><col><col style="width:13mm"><col style="width:13mm"><col style="width:12mm"><col style="width:16mm"><col style="width:28mm"></colgroup>' +
          '<thead><tr><th>위치</th><th>품번</th><th>품명</th><th class="n">DMS</th><th class="n">실사</th><th class="n">차이</th><th>확인자</th><th>메모</th></tr></thead>',
        rows: d.diffItems.map(function (it) {
          var df = Number(it.counted) - Number(it.qty);
          return '<tr><td class="m">' + esc(it.lct_cd || "-") + '</td><td class="m">' + esc(it.item_cd) + '</td><td>' + esc(it.item_nm) + '</td>' +
            '<td class="n">' + num(it.qty) + '</td><td class="n">' + num(it.counted) + '</td><td class="n ' + (df < 0 ? "neg" : "pos") + '">' + (df > 0 ? "+" : "") + num(df) + '</td>' +
            '<td>' + esc(it.by || "") + '</td><td>' + esc(it.memo || "") + '</td></tr>';
        })
      } });
    } else out.push({ html: '<div class="rp-none">수량이 다른 부품이 없습니다</div>' });

    out.push({ html: '<h2 class="rp-h">미확인 ' + d.leftItems.length + '건</h2>' });
    if (d.leftItems.length) {
      out.push({ table: {
        head: '<colgroup><col style="width:22mm"><col style="width:32mm"><col><col style="width:18mm"></colgroup>' +
          '<thead><tr><th>위치</th><th>품번</th><th>품명</th><th class="n">DMS 수량</th></tr></thead>',
        rows: d.leftItems.map(function (it) {
          return '<tr><td class="m">' + esc(it.lct_cd || "-") + '</td><td class="m">' + esc(it.item_cd) + '</td><td>' + esc(it.item_nm) + '</td><td class="n">' + num(it.qty) + '</td></tr>';
        })
      } });
    } else out.push({ html: '<div class="rp-none">모두 확인했습니다</div>' });

    out.push({ html: '<div class="rp-sign"><div><span>담당</span><i></i></div><div><span>확인</span><i></i></div><div><span>승인</span><i></i></div></div>' });
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
    var contentH = (PAGE.h - PAGE.margin - 20) * PX_PER_MM;   // .rp-page 위 여백 12mm, 아래 20mm(쪽 아래 문구 자리 포함)
    var probe = document.createElement("div");
    probe.className = "rp-page";
    Object.assign(probe.style, { position: "fixed", left: "-20000px", top: "0", height: "auto", overflow: "visible" });
    document.body.appendChild(probe);
    var pages = [], cur = "", used = 0;
    var flush = function () { if (cur) pages.push(cur); cur = ""; used = 0; };
    // 블록 하나를 단독으로 그렸을 때 차지하는 높이 (바깥 여백 포함: 위아래에 기준 선을 두고 잰다)
    var measure = function (html) {
      probe.innerHTML = '<div style="height:0"></div>' + html + '<div style="height:0"></div>';
      var k = probe.children;
      return k[k.length - 1].getBoundingClientRect().top - k[0].getBoundingClientRect().bottom;
    };
    try {
      list.forEach(function (b) {
        if (!b.table) {
          var h = measure(b.html);
          if (used + h > contentH && cur) flush();
          cur += b.html; used += h;
          return;
        }
        // 표: 머리글 높이와 줄마다 높이를 한 번에 잰다
        probe.innerHTML = '<table class="rp-list">' + b.table.head + '<tbody>' + b.table.rows.join("") + '</tbody></table>';
        var t = probe.firstChild, headH = t.tHead.getBoundingClientRect().height;
        var rowH = [].map.call(t.tBodies[0].rows, function (r) { return r.getBoundingClientRect().height; });
        var seg = [];
        var close = function () { if (seg.length) cur += '<table class="rp-list">' + b.table.head + '<tbody>' + seg.join("") + '</tbody></table>'; seg = []; };
        if (cur && used + headH + (rowH[0] || 0) > contentH) flush();
        used += headH;
        b.table.rows.forEach(function (r, i) {
          if (used + rowH[i] > contentH && seg.length) { close(); flush(); used = headH; }   // 다음 쪽에서 머리글 반복
          seg.push(r); used += rowH[i];
        });
        close();
      });
      flush();
    } finally {
      probe.remove();
    }
    return pages.map(function (html, i) {
      return '<div class="rp-page">' + html + '<div class="rp-foot">' + FOOTER + ' · ' + (i + 1) + ' / ' + pages.length + '</div></div>';
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

  /** 공유 메뉴로 보낸다 (안드로이드: OneDrive·메일·메신저 등). 버튼을 누른 그 순간에 불러야 열린다 */
  async function shareFile(file) {
    if (!navigator.canShare || !navigator.canShare({ files: [file] })) return "unsupported";
    try {
      await navigator.share({ files: [file], title: file.name });
      return "shared";
    } catch (e) {
      return e && e.name === "AbortError" ? "cancelled" : "blocked";   // blocked = 누른 지 오래돼 브라우저가 거절
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
