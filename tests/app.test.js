// 앱 시험: 가짜 Supabase 응답으로 실제 브라우저에서 앱을 돌려 봄 (DMS·데몬·실제 DB 필요 없음)
//
// 준비 (처음 한 번):
//   npm i --no-save playwright && npx playwright install chromium
//   npm pack @supabase/supabase-js@2.117.2 && tar xzf supabase-supabase-js-2.117.2.tgz -C tests/vendor
//     → tests/vendor/package/dist/umd/supabase.js (index.html 의 CDN 버전과 같게)
// 실행:  node tests/app.test.js
//   환경 변수로 바꿀 수 있음: SUPABASE_JS (supabase.js 경로), CHROMIUM (브라우저 실행 파일), SHOTS (화면 캡처 저장 폴더)
const http = require('http'), fs = require('fs'), path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const ROOT = path.join(__dirname, '..');
const SBJS = process.env.SUPABASE_JS || path.join(__dirname, 'vendor/package/dist/umd/supabase.js');
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
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
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
  const audit = { id: 'aaaaaaaa-0000-0000-0000-000000000001', kind: 'weekly', period_start: '2026-09-28', period_end: '2026-10-03', item_count: 2, started_by: USER.id, started_by_name: '시험', started_at: iso(now - 3600000) };
  const auditItems = [
    { audit_id: audit.id, item_cd: 'PN10000', item_nm: '부품0', lct_cd: 'A140112', qty: 1, status: null, counted: null, memo: null, checked_by_name: null, checked_at: null },
    { audit_id: audit.id, item_cd: 'PN10001', item_nm: '부품1', lct_cd: 'A140112', qty: 2, status: null, counted: null, memo: null, checked_by_name: null, checked_at: null },
  ];
  let checks = [], nextCheckId = 1;
  let failAuditPatch = false;
  const moveReqs = [
    { id: 3, item_cd: 'PN10002', params: { from: 'A140112', to: 'B000001' }, status: 'done', result: { from: 'A140112', to: 'B000001' }, error: null, requested_by_name: '김철수', requested_at: iso(now - 60000) },
    { id: 2, item_cd: 'PN10003', params: { from: 'A140112', to: 'C000001' }, status: 'failed', result: null, error: 'DMS 저장 실패', requested_by_name: '이영희', requested_at: iso(now - 120000) },
    { id: 1, item_cd: 'XX99999', params: { from: '', to: 'D000001' }, status: 'cancelled', result: null, error: '응답이 없어 취소했습니다', requested_by_name: '김철수', requested_at: iso(now - 86400000 * 2) },
  ];
  const reqLog = [];

  await page.route('https://cdn.jsdelivr.net/npm/@supabase/**', r => r.fulfill({ path: SBJS, contentType: 'text/javascript' }));
  await page.route(SB + '/**', async route => {
    const req = route.request(), u = new URL(req.url()), m = req.method(), t = u.pathname.replace('/rest/v1/', '');
    reqLog.push(m + ' ' + t + u.search);
    const json = (body, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers: Object.assign({ 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range' }, headers), body: JSON.stringify(body) });
    if (m === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (u.pathname.startsWith('/auth/')) return json({});
    if (t === 'profiles') return json({ id: USER.id, login_id: 't', name: '시험', role: 'staff', branch: '해운대', active: true, must_change_password: false });
    if (t === 'inv_status') return json({ branch: '해운대', parts_at: partsAt, daemon_seen_at: iso(Date.now()) });
    if (t === 'inv_parts') {
      if (m === 'HEAD') return route.fulfill({ status: 200, headers: { 'content-range': '*/' + parts.length, 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range' } });
      const gte = u.searchParams.get('updated_at');
      const rows = gte ? parts.filter(p => Date.parse(p.updated_at) >= Date.parse(gte.replace('gte.', ''))) : parts;
      return json(rows);
    }
    if (t === 'inv_audit_source') return json([src]);
    if (t === 'inv_audits') return json([audit]);
    if (t === 'inv_audit_items') {
      if (m === 'GET') return json(auditItems);
      if (m === 'PATCH') {
        if (failAuditPatch) return route.abort('internetdisconnected');
        const body = JSON.parse(req.postData()); const pn = u.searchParams.get('item_cd').replace('eq.', '');
        const it = auditItems.find(x => x.item_cd === pn); Object.assign(it, body, { checked_by_name: '시험', checked_at: iso(Date.now()) });
        return json(it);   // .single() → object
      }
    }
    if (t === 'inv_requests' && m === 'GET') return json(moveReqs);
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
    if (diff) { await page.click('#aDiffToggle'); await page.fill('#aCountIn', String(n)); await page.click('#aDiffSave'); }
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

  // ===== 데몬 멈춤 안내가 스캐너 영역에 갱신 =====
  await page.click('[data-tab="scan"]');
  await page.waitForSelector('#daemonNotice', { state: 'attached' });
  const n1 = await page.textContent('#daemonNotice');
  await page.route(SB + '/rest/v1/inv_status*', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ branch: '해운대', parts_at: partsAt, daemon_seen_at: iso(now - 3600000) }) }));
  await page.clock.fastForward(61000); await page.waitForTimeout(500);
  const n2 = await page.textContent('#daemonNotice');
  check('데몬 멈추면 스캔 화면 안내가 바로 나타남', n1 === '' && n2.includes('응답하지 않습니다'), JSON.stringify([n1, n2.slice(0, 30)]));

  check('체크 기록 0건이면 배지 숨김', !(await page.isVisible('#badge')));

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

  console.log(results.join('\n'));
  const errs = logs.filter(l => l.startsWith('PAGEERROR'));
  if (errs.length) console.log('--- 앱 스크립트 오류\n' + errs.join('\n'));
  await browser.close(); server.close();
  if (errs.length || results.some(r => r.startsWith('FAIL'))) process.exit(1);
})().catch(e => { console.error(e); console.log(results.join('\n')); server.close(); process.exit(1); });
