// 앱 시험: 가짜 Supabase 응답으로 실제 브라우저에서 앱을 돌려 봄 (DMS·데몬·실제 DB 필요 없음)
//
// 준비 (처음 한 번):
//   npm i --no-save playwright && npx playwright install chromium
//   npm pack @supabase/supabase-js@2.117.2 && tar xzf supabase-supabase-js-2.117.2.tgz -C tests/vendor
//     → tests/vendor/package/dist/umd/supabase.js (index.html 의 CDN 버전과 같게)
//   mkdir -p tests/vendor/jspdf && npm pack jspdf@4.2.1 && tar xzf jspdf-4.2.1.tgz -C tests/vendor/jspdf  (report.js 와 같은 버전)
// 실행:  node tests/app.test.js
//   환경 변수로 바꿀 수 있음: SUPABASE_JS (supabase.js 경로), JSPDF_JS (jspdf.umd.min.js 경로), CHROMIUM (브라우저 실행 파일), SHOTS (화면 캡처 저장 폴더)
const http = require('http'), fs = require('fs'), path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const ROOT = path.join(__dirname, '..');
const SBJS = process.env.SUPABASE_JS || path.join(__dirname, 'vendor/package/dist/umd/supabase.js');
const JSPDF = process.env.JSPDF_JS || path.join(__dirname, 'vendor/jspdf/package/dist/jspdf.umd.min.js');
const SB = 'https://qswzxudtzjuheugdnuoc.supabase.co';
const USER = { id: '11111111-1111-1111-1111-111111111111' };
const PORT = 8123;

const server = http.createServer((req, res) => {
  let f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (f.endsWith('/')) f += 'index.html';
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(d); });
});

const results = [];
function check(name, ok, extra) { results.push((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); }

(async () => {
  if (!fs.existsSync(SBJS)) throw new Error('supabase.js 가 없습니다: ' + SBJS + ' (파일 위 준비 참고)');
  await new Promise(r => server.listen(PORT, r));
  // 언어 설정이 비어 있는 서버에서는 브라우저가 한글 파일 이름을 'download' 로 바꾸므로 UTF-8 로 띄움
  const env = Object.assign({}, process.env, { LANG: process.env.LANG || 'C.UTF-8' });
  const browser = await chromium.launch(Object.assign({ env }, process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}));
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => logs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message));

  const now = Date.now();
  await page.clock.install({ time: now });

  // ---- 가짜 데이터 ----
  const iso = t => new Date(t).toISOString();
  let partsAt = iso(now - 60000);
  const parts = [];
  for (let i = 0; i < 15; i++) parts.push({ item_cd: 'PN' + String(10000 + i), item_nm: '부품' + i, lct_cd: 'A140112', crt_qty: i + 1, alois_cd: 'A1', last_purc_dt: null, updated_at: iso(now - 600000) });
  parts.push({ item_cd: 'PN20000', item_nm: '다른', lct_cd: 'B000001', crt_qty: 2, alois_cd: null, last_purc_dt: null, updated_at: iso(now - 600000) });
  const src = { kind: 'weekly', period_start: '2026-09-28', period_end: '2026-10-03', items: [], updated_at: iso(now) };
  const audit = { id: 'aaaaaaaa-0000-0000-0000-000000000001', kind: 'weekly', period_start: '2026-09-28', period_end: '2026-10-03', item_count: 3, finished_at: null, started_by: USER.id, started_by_name: '시험', started_at: iso(now - 3600000) };
  const auditItems = [
    { audit_id: audit.id, item_cd: 'PN10000', item_nm: '부품0', lct_cd: 'A140112', qty: 1, status: null, counted: null, memo: null, checked_by_name: null, checked_at: null },
    { audit_id: audit.id, item_cd: 'PN10001', item_nm: '부품1', lct_cd: 'A140112', qty: 2, status: null, counted: null, memo: null, checked_by_name: null, checked_at: null },
    { audit_id: audit.id, item_cd: 'PN10002', item_nm: '부품2', lct_cd: 'B000001', qty: 3, status: null, counted: null, memo: null, checked_by_name: null, checked_at: null },
  ];
  let checks = [], nextCheckId = 1;
  let failAuditPatch = false;
  let rrErr = null, rrPartsAt = iso(now - 120000);
  const reqPosts = [];
  const rrParts = [
    { item_cd: 'PN10000', item_nm: 'RR부품', lct_cd: 'R010101', crt_qty: 4 },
    { item_cd: 'QQ12345', item_nm: 'RR전용', lct_cd: 'R020202', crt_qty: 7 },
  ];
  const moveReqs = [
    { id: 3, item_cd: 'PN10002', params: { from: 'A140112', to: 'B000001' }, status: 'done', result: { from: 'A140112', to: 'B000001' }, error: null, requested_by_name: '김철수', requested_at: iso(now - 60000) },
    { id: 2, item_cd: 'PN10003', params: { from: 'A140112', to: 'C000001' }, status: 'failed', result: null, error: 'DMS 저장 실패', requested_by_name: '이영희', requested_at: iso(now - 120000) },
    { id: 1, item_cd: 'XX99999', params: { from: '', to: 'D000001' }, status: 'cancelled', result: null, error: '응답이 없어 취소했습니다', requested_by_name: '김철수', requested_at: iso(now - 86400000 * 2) },
  ];
  const reqLog = [];

  await page.route('https://cdn.jsdelivr.net/npm/@supabase/**', r => r.fulfill({ path: SBJS, contentType: 'text/javascript' }));
  await page.route('https://cdn.jsdelivr.net/npm/jspdf@*/**', r => r.fulfill({ path: JSPDF, contentType: 'text/javascript' }));
  await page.route(SB + '/**', async route => {
    const req = route.request(), u = new URL(req.url()), m = req.method(), t = u.pathname.replace('/rest/v1/', '');
    reqLog.push(m + ' ' + t + u.search);
    const json = (body, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers: Object.assign({ 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range' }, headers), body: JSON.stringify(body) });
    if (m === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (u.pathname.startsWith('/auth/')) return json({});
    if (t === 'profiles') return json({ id: USER.id, login_id: 't', name: '시험', role: 'staff', branch: '해운대', active: true, must_change_password: false });
    if (t === 'inv_status') return json({ branch: '해운대', parts_at: partsAt, daemon_seen_at: iso(Date.now() + 3600000), rr_parts_at: rrPartsAt, rr_error: rrErr });   // 페이지 시계를 앞으로 돌려도 '방금 응답'으로 보이게
    if (t === 'inv_parts') {
      if (m === 'HEAD') return route.fulfill({ status: 200, headers: { 'content-range': '*/' + parts.length, 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range' } });
      const gte = u.searchParams.get('updated_at');
      const rows = gte ? parts.filter(p => Date.parse(p.updated_at) >= Date.parse(gte.replace('gte.', ''))) : parts;
      return json(rows);
    }
    if (t === 'inv_audit_source') return json([src]);
    if (t === 'inv_audits') return json([audit]);
    if (t === 'rpc/inv_reopen_audit') { Object.assign(audit, { finished_at: null, finished_by_name: null, reopened_at: iso(Date.now()), reopened_by_name: '시험' }); return json(null, 204); }
    if (t === 'rpc/inv_finish_audit') { Object.assign(audit, { finished_at: iso(Date.now()), finished_by_name: '시험' }); return json(null, 204); }
    if (t === 'inv_audit_items') {
      if (m === 'GET') return json(auditItems);
      if (m === 'PATCH') {
        if (failAuditPatch) return route.abort('internetdisconnected');
        const body = JSON.parse(req.postData()); const pn = u.searchParams.get('item_cd').replace('eq.', '');
        const it = auditItems.find(x => x.item_cd === pn); Object.assign(it, body, { checked_by_name: '시험', checked_at: iso(Date.now()) });
        return json(it);   // .single() → object
      }
    }
    if (t === 'inv_requests' && m === 'POST') { reqPosts.push(JSON.parse(req.postData())); return json({ id: 999 }, 201); }
    if (t === 'inv_requests' && m === 'GET') return json(moveReqs);
    if (t === 'inv_rr_parts') return json(rrParts);
    if (t === 'inv_checks') {
      if (m === 'GET') {
        let rows = checks.filter(c => !c.cleared_at);
        const aid = u.searchParams.get('audit_id'), pn = u.searchParams.get('item_cd');
        if (aid) rows = rows.filter(c => 'eq.' + c.audit_id === aid && 'eq.' + c.item_cd === pn);
        return json(rows);
      }
      if (m === 'POST') { const b = JSON.parse(req.postData()); checks.push(Object.assign({ id: nextCheckId++, checked_at: iso(Date.now()), cleared_at: null }, b)); return json(null, 201); }
      if (m === 'PATCH') {
        const b = JSON.parse(req.postData()); const idq = u.searchParams.get('id');
        const ids = idq.startsWith('in.') ? idq.slice(4, -1).split(',').map(Number) : [Number(idq.replace('eq.', ''))];
        checks.forEach(c => { if (ids.includes(c.id)) Object.assign(c, b); });
        return json(null, 204);
      }
    }
    return json([]);
  });

  // 로그인된 세션을 미리 넣어 둠
  await page.addInitScript(([uid, exp]) => {
    localStorage.setItem('inventory-scan-auth', JSON.stringify({ access_token: 'x', refresh_token: 'y', token_type: 'bearer', expires_in: 3600, expires_at: exp, user: { id: uid, aud: 'authenticated', role: 'authenticated' } }));
  }, [USER.id, Math.floor(now / 1000) + 86400 * 365]);

  await page.goto('http://localhost:' + PORT + '/');
  await page.waitForSelector('#manualInput', { timeout: 10000 });

  // ===== 3. 위치 화면 검색어 유지 =====
  await page.fill('#manualInput', 'A140112');
  await page.press('#manualInput', 'Enter');
  await page.waitForSelector('#locSearch');
  await page.click('#locSearch');
  await page.keyboard.type('PN1000');
  partsAt = iso(Date.now() + 1000);   // 다음 확인 때 바뀐 것 받기
  parts[0].crt_qty = 99; parts[0].updated_at = iso(Date.now() + 1000);
  reqLog.length = 0;
  await page.clock.fastForward(61000);
  await page.waitForTimeout(500);
  const val = await page.inputValue('#locSearch');
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
  check('위치 검색어 유지', val === 'PN1000', 'value=' + val);
  check('검색칸 포커스 유지', focused === 'locSearch', 'focus=' + focused);
  const after = await page.$$eval('#locList .prow', e => e.length);
  check('검색 결과 그대로 걸러짐', after === 10, 'rows=' + after + ' (전체 15)');

  // ===== 7a. 현재고 바뀐 것만 받기 =====
  const partsReqs = reqLog.filter(x => x.includes('inv_parts'));
  check('현재고 증분 요청 (updated_at=gte)', partsReqs.some(x => x.startsWith('GET') && x.includes('updated_at=gte')), partsReqs.join(' | '));
  check('개수 확인 HEAD 요청', partsReqs.some(x => x.startsWith('HEAD')));
  check('전체 다시 받기 안 함', !partsReqs.some(x => x.startsWith('GET') && !x.includes('updated_at')));
  const q0 = await page.evaluate(() => document.querySelector('#locList').textContent.includes('99'));
  check('바뀐 수량 반영', q0);

  // 품번 하나 사라짐 → 개수 달라 전체 다시 받음
  parts.pop(); partsAt = iso(Date.now() + 2000); reqLog.length = 0;
  await page.clock.fastForward(61000); await page.waitForTimeout(500);
  check('품번 사라지면 전체 다시 받음', reqLog.some(x => x.startsWith('GET inv_parts') && !x.includes('updated_at=gte')), reqLog.filter(x => x.includes('inv_parts')).join(' | '));

  // ===== 4. 재고조사: 전파 끊김 → 휴대폰에 저장 → 연결되면 보냄 =====
  await page.click('[data-tab="audit"]');
  await page.click('[data-audit="weekly"]');
  await page.waitForSelector('[data-aitem="PN10000"]');
  failAuditPatch = true;
  await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
  await page.click('[data-aitem="PN10000"]');
  await page.click('#aOk');
  await page.waitForTimeout(300);
  const ob1 = await page.evaluate(() => JSON.parse(localStorage.getItem('inv.auditOutbox') || '[]').length);
  check('끊겼을 때 휴대폰에 저장', ob1 === 1, 'outbox=' + ob1);
  await page.click('[data-afilter="all"]');
  const pend = await page.$eval('[data-aitem="PN10000"]', e => e.textContent);
  check('목록에 "전송 대기" 표시', pend.includes('전송 대기') && pend.includes('일치'), pend);
  const toast1 = await page.textContent('#toastText');
  check('안내 문구', toast1.includes('휴대폰에 저장'), toast1);

  failAuditPatch = false;
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }); window.dispatchEvent(new Event('online')); });
  await page.waitForTimeout(500);
  const ob2 = await page.evaluate(() => JSON.parse(localStorage.getItem('inv.auditOutbox') || '[]').length);
  check('연결되면 보내고 비움', ob2 === 0 && auditItems[0].status === 'ok', 'outbox=' + ob2 + ' server=' + auditItems[0].status);
  const pend2 = await page.$eval('[data-aitem="PN10000"]', e => e.textContent);
  check('"전송 대기" 사라짐', !pend2.includes('전송 대기'), pend2);

  // ===== 2. 수량 다름 → 다시 수량 다름 → 일치 =====
  async function mark(pn, diff, n) {
    await page.click('[data-aitem="' + pn + '"]');
    if (diff) { await page.click('#aDiffToggle'); if (await page.isVisible('#aOk')) throw new Error('수량 다름을 누르면 일치 버튼이 숨어야 함'); await page.fill('#aCountIn', String(n)); await page.click('#aDiffSave'); }
    else await page.click('#aOk');
    await page.waitForTimeout(300);
  }
  await mark('PN10001', true, 5);
  await mark('PN10001', true, 6);
  const open1 = checks.filter(c => c.item_cd === 'PN10001' && !c.cleared_at);
  check('수량 다름 두 번 저장해도 체크 기록 1건', open1.length === 1 && open1[0].counted_qty === 6, JSON.stringify(open1.map(c => c.counted_qty)));
  await mark('PN10001', false);
  const open2 = checks.filter(c => c.item_cd === 'PN10001' && !c.cleared_at);
  check('일치로 바꾸면 체크 기록 지움', open2.length === 0, 'open=' + open2.length);
  check('지울 때 이름은 보내지 않음 (서버가 채움)', checks.every(c => !('cleared_by_name' in c)));

  // ===== 재고조사 종료 → 보고서 → PDF =====
  await mark('PN10001', true, 5);   // 수량 다름 1, 미확인 1 (PN10002), 일치 1
  const finBtn = await page.$('#auditFinish');
  check('진행 중 조사에 "조사 종료" 버튼', !!finBtn);
  await page.click('#auditFinish');
  const finSheet = await page.textContent('#sheet');
  check('종료 확인 창에 요약·미확인 안내', finSheet.includes('미확인') && finSheet.includes('1건은 보고서에'), '');
  await page.evaluate(() => {   // 공유 메뉴 흉내 (OneDrive 로 보내기)
    window.__shared = null;
    navigator.canShare = () => true;
    navigator.share = async (d) => { window.__shared = { name: d.files[0].name, size: d.files[0].size, type: d.files[0].type, title: d.title }; };
  });
  await page.click('#auditFinishOk');
  await page.waitForSelector('#reportView');
  check('종료하면 서버에 종료 기록', !!audit.finished_at);
  const rv = await page.textContent('#rvPages');
  check('보고서에 요약·수량 다름·미확인', rv.includes('주간 재고조사 보고서') && rv.includes('PN10001') && rv.includes('+3') && rv.includes('PN10002') && rv.includes('미확인 1건'), '');
  const nm = await page.inputValue('#rvName');
  check('파일 이름', nm === '260928-1003 주간 재고조사 보고서', nm);
  await page.waitForFunction(() => document.getElementById('rvState').textContent.includes('PDF 준비됨'), null, { timeout: 30000 }).catch(() => {});
  const stt = await page.textContent('#rvState');
  check('PDF 미리 만들어 둠', stt.includes('PDF 준비됨'), stt);
  if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'report.png') });
  // 처음 한 번은 브라우저가 거절 → '다시 보내기' 와 오류 내용 표시, 다시 누르면 보냄
  await page.evaluate(() => {
    const ok = navigator.share; let n = 0;
    navigator.share = async (d) => { if (n++ === 0) throw new DOMException('Permission denied', 'NotAllowedError'); return ok(d); };
  });
  await page.click('#rvShare');
  await page.waitForTimeout(200);
  const retryTxt = await page.textContent('#rvRetry');
  check('거절되면 다시 보내기 버튼과 오류 내용', (await page.isVisible('#rvShare2')) && retryTxt.includes('NotAllowedError: Permission denied'), retryTxt);
  await page.click('#rvShare2');
  await page.waitForTimeout(200);
  check('다시 보내면 성공하고 다시 보내기 숨김', !(await page.isVisible('#rvShare2')), '');
  // 삼성 인터넷: PDF 공유를 막음 → 다시 보내기 대신 '크롬에서 열기'
  await page.evaluate(() => {
    window.__ua = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => window.__ua + ' SamsungBrowser/28.0' });
    window.__ok = navigator.share;
    navigator.share = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); };
  });
  await page.click('#rvShare');
  await page.waitForTimeout(200);
  const sm = await page.textContent('#rvRetry');
  const href = await page.getAttribute('#rvChrome', 'href');
  check('삼성 인터넷이면 크롬에서 열기 안내', sm.includes('삼성 인터넷은 PDF 파일 공유를 막고') && await page.isVisible('#rvChrome') && !(await page.isVisible('#rvShare2')) && href.startsWith('intent://localhost') && href.includes('package=com.android.chrome'), href);
  await page.evaluate(() => { Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => window.__ua }); navigator.share = window.__ok; });
  check('보고서 종이는 강제 다크 모드 제외', await page.$eval('.rp-page', e => getComputedStyle(e).colorScheme.includes('light')), '');
  const shared = await page.evaluate(() => window.__shared);
  check('OneDrive 공유로 PDF 보냄', shared && shared.name === '260928-1003 주간 재고조사 보고서.pdf' && shared.type === 'application/pdf' && shared.size > 10000 && shared.title === undefined, JSON.stringify(shared));
  await page.fill('#rvName', '내 보고서');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#rvDownload')]);
  const pdfPath = path.join(process.env.SHOTS || require('os').tmpdir(), 'report.pdf');
  await dl.saveAs(pdfPath);
  const pdfBuf = fs.readFileSync(pdfPath);
  check('내려받은 파일이 PDF (이름 바꾸기 반영)', dl.suggestedFilename() === '내 보고서.pdf' && pdfBuf.slice(0, 5).toString() === '%PDF-', dl.suggestedFilename());
  await page.click('#rvClose');
  check('닫으면 미리보기 사라짐', !(await page.$('#reportView')));
  const afterFin = await page.textContent('#view');
  check('종료 후: 종료 표시·보고서 버튼, 종료 버튼 없음', afterFin.includes('종료 · 더 이상 고칠 수 없습니다') && !!(await page.$('#auditReport')) && !(await page.$('#auditFinish')), '');
  check('종료 후: 항목 못 누름, 스캐너 숨김', await page.$eval('[data-aitem="PN10002"]', e => e.disabled) && await page.$eval('#scannerHost', e => e.hidden), '');
  await page.click('#auditBack');
  const card = await page.textContent('[data-audit="weekly"]');
  check('조사 카드에 "종료"', card.includes('종료'), card);

  // ===== 잘못 종료했을 때 다시 시작 =====
  await page.click('[data-audit="weekly"]');
  await page.waitForSelector('#auditReopen');
  await page.click('#auditReopen');
  const ro = await page.textContent('#sheet');
  check('다시 시작 확인 창: 확인한 것 그대로, 남은 것부터', ro.includes('그대로 두고') && ro.includes('남은 1건'), '');
  await page.click('#auditReopenOk');
  await page.waitForTimeout(300);
  check('다시 열면 서버 종료 표시 지움', !audit.finished_at && audit.reopened_by_name === '시험', JSON.stringify({ f: audit.finished_at, r: audit.reopened_by_name }));
  const reo = await page.textContent('#view');
  check('다시 열면 이어서 확인 가능 (종료 버튼·스캐너·남은 것)', !!(await page.$('#auditFinish')) && !(await page.$('#auditReport')) && !(await page.$eval('#scannerHost', e => e.hidden)) && reo.includes('남은 것 1') && !(await page.$eval('[data-aitem="PN10002"]', e => e.disabled)), '');
  const kept = auditItems.filter(x => x.status).length;
  check('확인한 내용은 그대로', kept === 2, 'kept=' + kept);
  await page.click('#auditBack');

  // ===== RR 재고 (BMW 처럼 올라온 현재고를 바로 보여 줌, 조회 버튼 없음) =====
  await page.click('[data-tab="scan"]');
  await page.fill('#manualInput', 'PN10000');
  await page.press('#manualInput', 'Enter');
  await page.waitForSelector('#rrTile');
  const rr1 = await page.textContent('#rrTile');
  check('부품 화면에 RR 재고 바로 표시', rr1.includes('4') && rr1.includes('R010101') && rr1.includes('기준') && !(await page.$('#rrTile button')), rr1);
  check('RR 재고 보려고 요청 보내지 않음', !reqPosts.length, JSON.stringify(reqPosts));
  if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'rr.png') });
  await page.fill('#manualInput', 'PN10001');
  await page.press('#manualInput', 'Enter');
  await page.waitForTimeout(200);
  const rr0 = await page.textContent('#rrTile');
  check('RR 에 없는 품번은 0 · 없음', rr0.includes('0') && rr0.includes('RR 부품창고에 없음'), rr0);
  // RR 데몬이 새로 올리면 반영
  rrParts.push({ item_cd: 'PN10001', item_nm: 'RR부품1', lct_cd: 'R030303', crt_qty: 9 });
  rrPartsAt = iso(Date.now());
  await page.clock.fastForward(61000); await page.waitForTimeout(400);
  const rr9 = await page.textContent('#rrTile');
  check('RR 데몬이 새로 올리면 반영', rr9.includes('9') && rr9.includes('R030303'), rr9);
  rrErr = 'RR DMS 메뉴를 열지 못했습니다 — RR DMS 로그인 확인 필요';
  await page.clock.fastForward(61000); await page.waitForTimeout(300);
  const rrS = await page.textContent('#rrTile');
  check('RR 을 못 올리면 "갱신 안 됨"', rrS.includes('갱신 안 됨') && rrS.includes('9'), rrS);
  await page.click('[data-tab="settings"]');
  const stE = await page.textContent('#view');
  check('설정에 RR 실패 이유', stE.includes('RR DMS 로그인 확인 필요'), '');
  await page.click('[data-tab="scan"]');
  rrErr = null;
  await page.clock.fastForward(61000); await page.waitForTimeout(300);
  await page.fill('#manualInput', 'QQ12345');
  await page.press('#manualInput', 'Enter');
  await page.waitForSelector('#unknownLookup');
  const us = await page.textContent('#sheet');
  check('BMW 목록에 없는 품번 창에 RR 재고 바로 표시', us.includes('RR 재고') && us.includes('7') && us.includes('R020202'), '');
  await page.click('[data-close]');
  await page.click('[data-tab="settings"]');
  const st = await page.textContent('#view');
  check('설정에 RR 기준 시각, 문제 없으면 이유 안 보임', st.includes('RR 현재고 기준 시각') && !st.includes('RR 현재고 문제'), '');

  // ===== 데몬 멈춤 안내가 스캐너 영역에 갱신 =====
  await page.click('[data-tab="scan"]');
  await page.waitForSelector('#daemonNotice', { state: 'attached' });
  const n1 = await page.textContent('#daemonNotice');
  await page.route(SB + '/rest/v1/inv_status*', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ branch: '해운대', parts_at: partsAt, daemon_seen_at: iso(now - 3600000) }) }));
  await page.clock.fastForward(61000); await page.waitForTimeout(500);
  const n2 = await page.textContent('#daemonNotice');
  check('데몬 멈추면 스캔 화면 안내가 바로 나타남', n1 === '' && n2.includes('응답하지 않습니다'), JSON.stringify([n1, n2.slice(0, 30)]));

  const openChecks = checks.filter(c => !c.cleared_at).length;
  check('체크 기록 배지: 0건이면 숨김, 있으면 건수', openChecks ? (await page.textContent('#badge')) === String(openChecks) && await page.isVisible('#badge') : !(await page.isVisible('#badge')), 'open=' + openChecks);

  // ===== 위치 변경 이력 화면 =====
  await page.click('[data-tab="settings"]');
  await page.click('#movesOpen');
  await page.waitForSelector('#moveList .diff');
  const mv = await page.$$eval('#moveList .diff', e => e.map(x => x.textContent));
  check('이력 3건 표시 (경로·상태)', mv.length === 3 && mv[0].includes('A140112 → B000001') && mv[0].includes('완료') && mv[1].includes('실패') && mv[2].includes('공란 → D000001') && mv[2].includes('취소'), JSON.stringify(mv));
  if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'moves.png') });
  const days = await page.$$eval('#moveList .section-label', e => e.length);
  check('날짜별로 묶음', days === 2, 'days=' + days);
  await page.click('[data-mfilter="problem"]');
  const prob = await page.$$eval('#moveList .diff', e => e.length);
  check('실패·취소만 보기', prob === 2, 'n=' + prob);
  await page.click('[data-mfilter="all"]');
  await page.fill('#moveSearch', 'c000');
  const srch = await page.$$eval('#moveList .diff', e => e.map(x => x.textContent));
  check('위치로 찾기', srch.length === 1 && srch[0].includes('C000001'), JSON.stringify(srch));
  await page.fill('#moveSearch', '');
  await page.click('[data-open="PN10002"]');
  await page.waitForSelector('[data-movelog="PN10002"]');
  check('이력에서 누르면 부품 화면', await page.isVisible('[data-movelog="PN10002"]'));
  await page.click('[data-movelog="PN10002"]');
  await page.waitForSelector('#moveList .diff');
  const one = await page.$$eval('#moveList .diff', e => e.length);
  const sv = await page.inputValue('#moveSearch');
  check('부품 화면에서 그 부품 이력만', one === 1 && sv === 'PN10002', 'n=' + one + ' q=' + sv);
  await page.click('#movesBack');
  check('돌아가기 → 부품 화면', await page.isVisible('[data-movelog="PN10002"]'));

  // ===== 재고조사·위치 화면에 RR 합계 (PN10000: BMW 1 + RR 4) =====
  await page.click('[data-tab="audit"]');
  await page.click('[data-audit="weekly"]');
  await page.waitForSelector('[data-afilter="all"]');
  await page.click('[data-afilter="all"]');   // 다시 연 조사는 '남은 것'으로 열림
  await page.waitForSelector('[data-aitem="PN10000"]');
  const arow = await page.textContent('[data-aitem="PN10000"]');
  check('재고조사 목록에 BMW + RR 와 합계', arow.includes('BMW 1 + RR 4') && arow.includes('5EA'), arow);
  await page.click('[data-aitem="PN10000"]');
  const ash = await page.textContent('#sheet');
  const qs = await page.$eval('#sheet .qsplit', e => e.textContent);
  check('확인 창에 합계와 BMW·RR 따로', ash.includes('BMW + RR 합계') && qs === 'BMW1RR4', qs);
  await page.click('#aDiffToggle');
  check('실사 수량 기본값 = 합계', (await page.inputValue('#aCountIn')) === '5');
  await page.click('#aDiffSave');   // 합계와 같으면 일치
  await page.waitForTimeout(300);
  check('합계와 같으면 일치로 저장', auditItems[0].status === 'ok' && !checks.some(c => c.item_cd === 'PN10000' && !c.cleared_at), auditItems[0].status);
  await page.click('[data-aitem="PN10000"]');
  await page.click('#aDiffToggle');
  await page.fill('#aCountIn', '3');
  await page.click('#aDiffSave');
  await page.waitForTimeout(300);
  const ck = checks.find(c => c.item_cd === 'PN10000' && !c.cleared_at);
  check('수량 다름 체크에 RR 수량도 저장', ck && ck.dms_qty === 1 && ck.rr_qty === 4 && ck.counted_qty === 3, JSON.stringify(ck));
  await page.click('[data-aitem="PN10002"]');
  const qs0 = await page.$eval('#sheet .qsplit', e => e.textContent);
  check('RR 이 없는 부품도 확인 창에 RR 0 표시', qs0 === 'BMW3RR0' && !(await page.textContent('#sheet')).includes('아직 올라오지 않아'), qs0);
  await page.click('[data-close]');
  await page.click('[data-tab="log"]');
  const lg = await page.textContent('#view');
  check('체크 기록: 합계 → 실사, 차이는 합계 기준', lg.includes('5 → 3') && lg.includes('−2') && lg.includes('BMW 1 + RR 4'), '');
  await page.click('[data-tab="scan"]');
  await page.fill('#manualInput', 'A140112');
  await page.press('#manualInput', 'Enter');
  await page.waitForSelector('#locList');
  const lrow = await page.$eval('[data-go="PN10000"]', e => e.textContent);
  check('위치 화면에 BMW + RR 와 합계', lrow.includes('BMW 99 + RR 4') && lrow.includes('103EA'), lrow);
  if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'loc_rr.png') });

  console.log(results.join('\n'));
  const errs = logs.filter(l => l.startsWith('PAGEERROR'));
  if (errs.length) console.log('--- 앱 스크립트 오류\n' + errs.join('\n'));
  await browser.close(); server.close();
  if (errs.length || results.some(r => r.startsWith('FAIL'))) process.exit(1);
})().catch(e => { console.error(e); console.log(results.join('\n')); server.close(); process.exit(1); });
