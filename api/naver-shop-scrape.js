// Vercel 서버리스 함수 — 네이버 쇼핑 검색 페이지 HTML 에서 shoppingResult JSON 직접 추출
// 호출: GET /api/naver-shop-scrape?query=버즈4+프로+케이스
// 응답: { query, products: [...], terms: [...], total, source }
// 비고: 모바일/데스크탑 URL 순차 시도 + 브라우저 위장 헤더

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UA_MOBILE  = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function buildHeaders(isMobile) {
  return {
    'User-Agent': isMobile ? UA_MOBILE : UA_DESKTOP,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': isMobile ? 'https://m.naver.com/' : 'https://www.naver.com/',
    'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'Sec-Ch-Ua-Mobile': isMobile ? '?1' : '?0',
    'Sec-Ch-Ua-Platform': isMobile ? '"iOS"' : '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  };
}

// HTML 안의 <script id="__NEXT_DATA__" ...>{json}</script> 형태에서 JSON 추출
function extractNextData(html) {
  const m = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (_) { return null; }
}

// __NEXT_DATA__ 트리 안에서 products 배열이 있는 노드를 찾음
function findProducts(obj, depth) {
  if (!obj || typeof obj !== 'object' || depth > 10) return null;
  if (obj.shoppingResult && Array.isArray(obj.shoppingResult.products)) {
    return {
      products: obj.shoppingResult.products,
      total: obj.shoppingResult.total || 0,
      terms: obj.shoppingResult.terms || obj.terms || [],
      nluTerms: obj.shoppingResult.nluTerms || obj.nluTerms || [],
      query: obj.shoppingResult.query || obj.query || '',
    };
  }
  if (Array.isArray(obj.products) && obj.products.length && typeof obj.products[0] === 'object'
      && ('manuTag' in obj.products[0] || 'productTitle' in obj.products[0] || 'productName' in obj.products[0])) {
    return {
      products: obj.products,
      total: obj.total || 0,
      terms: obj.terms || [],
      nluTerms: obj.nluTerms || [],
      query: obj.query || '',
    };
  }
  for (const k of Object.keys(obj)) {
    const found = findProducts(obj[k], depth + 1);
    if (found) return found;
  }
  return null;
}

// 탭별 갯수 찾기 — 트리 안에서 {name, total} 형태(혹은 유사)의 productSet 정보 추출
// 결과: { '전체': N, '가격비교': N, '네이버페이': N, ... } (찾은 것만)
function findTabTotals(obj, depth, out) {
  out = out || {};
  if (!obj || typeof obj !== 'object' || depth > 12) return out;
  if (Array.isArray(obj)) {
    obj.forEach(v => findTabTotals(v, depth + 1, out));
    return out;
  }
  // 이름+totalCount/total 형태
  const name = obj.name || obj.title || obj.label;
  const totalField = obj.totalCount ?? obj.total ?? obj.count;
  if (typeof name === 'string' && typeof totalField === 'number' && totalField > 0) {
    const KNOWN = ['전체','가격비교','네이버페이','백화점','홈쇼핑','쇼핑윈도','해외직구','백화점/홈쇼핑'];
    if (KNOWN.includes(name) && (out[name] == null || out[name] < totalField)) {
      out[name] = totalField;
    }
  }
  for (const k of Object.keys(obj)) findTabTotals(obj[k], depth + 1, out);
  return out;
}

function regexFallback(html) {
  const products = [];
  const tags = [];
  const titles = [];
  const manuRe = /"manuTag"\s*:\s*"([^"]*)"/g;
  const titleRe = /"productTitle"\s*:\s*"([^"]*)"/g;
  let m;
  while ((m = manuRe.exec(html)) !== null) tags.push(m[1] || '');
  while ((m = titleRe.exec(html)) !== null) titles.push(m[1] || '');
  const len = Math.max(tags.length, titles.length);
  for (let i = 0; i < len; i++) {
    products.push({ manuTag: tags[i] || '', productTitle: titles[i] || '', _rank: i + 1 });
  }
  return products;
}

async function tryFetch(url, isMobile) {
  const r = await fetch(url, { headers: buildHeaders(isMobile) });
  const html = await r.text();
  return { ok: r.ok, status: r.status, html, len: html.length };
}

// raw HTML 에서 상품 "객체"를 통째로 추출 (확장 background.js extractProducts 와 동일 로직)
//   네이버 SERP 가 __NEXT_DATA__ 에 상품을 안 담는 경우에도 풀 필드(mallProductId·rank 등)를 확보.
function extractProductObjects(html) {
  const n = html.length;
  const inStr = new Uint8Array(n);
  let st = false, esc = false;
  for (let i = 0; i < n; i++) {
    const c = html.charCodeAt(i);
    if (esc) { esc = false; inStr[i] = 1; continue; }
    if (c === 92) { esc = true; if (st) inStr[i] = 1; continue; }
    if (c === 34) { if (st) inStr[i] = 1; st = !st; continue; }
    if (st) inStr[i] = 1;
  }
  const out = []; const seen = new Set();
  const needle = '"productTitle"'; let from = 0;
  while (true) {
    const k = html.indexOf(needle, from); if (k < 0) break; from = k + needle.length;
    if (inStr[k]) continue;
    let p = k + needle.length; while (p < n && (html[p] === ' ' || html[p] === '\n' || html[p] === '\t' || html[p] === '\r')) p++;
    if (html[p] !== ':') continue;
    let depth = 0, start = -1;
    for (let j = k; j >= 0; j--) { if (inStr[j]) continue; const ch = html[j]; if (ch === '}') depth++; else if (ch === '{') { if (depth === 0) { start = j; break; } depth--; } }
    if (start < 0) continue;
    let d2 = 0, end = -1;
    for (let j = start; j < n; j++) { if (inStr[j]) continue; const ch = html[j]; if (ch === '{') d2++; else if (ch === '}') { d2--; if (d2 === 0) { end = j + 1; break; } } }
    if (end < 0) continue;
    const block = html.slice(start, end);
    if (block.length > 300000) { if (end > from) from = end; continue; }
    try {
      const o = JSON.parse(block);
      if (o && (o.productTitle || o.productName)) {
        const id = String(o.id || o.nvMid || o.mallProductId || o.productId || o.productTitle);
        if (!seen.has(id)) { seen.add(id); out.push(o); }
      }
    } catch (_) {}
    if (end > from) from = end;
  }
  return out;
}
// 광고 제외(adId/adcrUrl/nvAdProductId 보유만) + 노출순위 정렬
function dropAdsAndSort(list) {
  const isAd = o => (o.adId && String(o.adId) !== '0') || o.adcrUrl || o.nvAdProductId;
  const rk = o => { const v = o.rank ?? o.productRank ?? o.nvShowRank; const n = Number(v); return isNaN(n) ? 1e9 : n; };
  return list.filter(o => !isAd(o)).map((o, i) => [o, i]).sort((a, b) => (rk(a[0]) - rk(b[0])) || (a[1] - b[1])).map(x => x[0]);
}

// HTML(또는 JSON 문자열)에서 products 추출 — 직접/프록시 공용
function parseProducts(html, q) {
  // 0) 상품 객체 통째 추출 — 가장 풍부한 필드(상품ID 매칭에 필요). 10개 이상이면 채택
  try {
    const objs = dropAdsAndSort(extractProductObjects(html));
    if (objs.length >= 10) {
      return { query: q, products: objs, total: objs.length, tabTotals: {}, terms: [], nluTerms: [], source: 'obj' };
    }
  } catch (_) {}
  const nextData = extractNextData(html);
  if (nextData) {
    const scope = findProducts(nextData.props, 0) || findProducts(nextData, 0);
    const tabTotals = findTabTotals(nextData, 0) || {};
    if (scope && scope.products && scope.products.length) {
      return { query: scope.query || q, products: scope.products, total: scope.total || scope.products.length, tabTotals, terms: scope.terms || [], nluTerms: scope.nluTerms || [], source: 'next-data' };
    }
  }
  // 프록시가 내부 API JSON 을 그대로 돌려주는 경우 (HTML 아님)
  try {
    const j = JSON.parse(html);
    const scope = findProducts(j, 0);
    if (scope && scope.products && scope.products.length) {
      return { query: scope.query || q, products: scope.products, total: scope.total || scope.products.length, tabTotals: {}, terms: scope.terms || [], nluTerms: scope.nluTerms || [], source: 'json' };
    }
  } catch (_) {}
  const products = regexFallback(html);
  if (products.length) return { query: q, products, total: products.length, tabTotals: {}, terms: [], nluTerms: [], source: 'regex' };
  return null;
}

// 스크래핑 API 프록시 — 네이버가 서버(데이터센터) IP 를 차단할 때 주거용/우회 IP 로 SERP 를 가져온다.
//   Vercel 환경변수에 키를 넣으면 자동 활성화:
//     SCRAPER_API_KEY      (scraperapi.com,  무료 1,000건/월)
//     SCRAPINGBEE_API_KEY  (scrapingbee.com, 무료 1,000크레딧)
//     SCRAPE_PROXY_URL     (직접 템플릿; "{url}" 자리에 인코딩된 대상 URL 치환)
// 프록시 키는 Vercel 환경변수 SCRAPINGBEE_API_KEY 로만 설정(공개 저장소 노출 방지).
// 유료 크레딧이 있을 때만 서버 스크랩(판다랭크식·브라우저 불필요)이 활성화됨. 없으면 프론트는 확장(무료)만 사용.
const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY || '';
function buildProxyUrl(target, withGeo) {
  const geo = process.env.SCRAPER_API_COUNTRY || 'kr';
  if (process.env.SCRAPER_API_KEY) {
    // 프리미엄/한국IP: SCRAPER_PREMIUM=true(프리미엄) 또는 ultra(주거용). 네이버는 보통 ultra 필요(유료).
    const p = { api_key: process.env.SCRAPER_API_KEY, url: target, keep_headers: 'true' };
    if (withGeo && geo && geo !== 'none') p.country_code = geo;
    const prem = (process.env.SCRAPER_PREMIUM || '').toLowerCase();
    if (prem === 'ultra') p.ultra_premium = 'true';
    else if (prem === 'true' || prem === 'premium') p.premium = 'true';
    return 'https://api.scraperapi.com/?' + new URLSearchParams(p).toString();
  }
  if (SCRAPINGBEE_API_KEY) {
    // 네이버엔 premium_proxy + country_code=kr 가 사실상 필수(무료체험 크레딧으로 테스트 가능).
    // forward_headers=true → 요청에 'Spb-' 프리픽스로 보낸 헤더를 대상(네이버)으로 전달(Referer 위장용).
    const p = { api_key: SCRAPINGBEE_API_KEY, url: target, render_js: (process.env.SCRAPINGBEE_RENDER || 'false'), forward_headers: 'true' };
    const usePrem = (process.env.SCRAPINGBEE_PREMIUM || 'true').toLowerCase() !== 'false';
    if (usePrem) p.premium_proxy = 'true';
    if (withGeo && geo && geo !== 'none') p.country_code = geo;
    return 'https://app.scrapingbee.com/api/v1/?' + new URLSearchParams(p).toString();
  }
  if (process.env.SCRAPE_PROXY_URL) {
    const tpl = process.env.SCRAPE_PROXY_URL;
    return tpl.includes('{url}') ? tpl.replace('{url}', encodeURIComponent(target)) : tpl + encodeURIComponent(target);
  }
  return null;
}
// Bright Data Web Unlocker (REST) — 성공한 요청에만 과금, 차단 우회(헤더/브라우저 지문)를 대신 처리.
//   Vercel 환경변수: BRIGHTDATA_API_KEY (API 키), BRIGHTDATA_ZONE (Web Unlocker 영역 이름),
//                   BRIGHTDATA_COUNTRY (기본 kr)
const BRIGHTDATA_API_KEY = process.env.BRIGHTDATA_API_KEY || '';
const BRIGHTDATA_ZONE = process.env.BRIGHTDATA_ZONE || '';
function brightDataConfigured() { return !!(BRIGHTDATA_API_KEY && BRIGHTDATA_ZONE); }
async function tryBrightDataFetch(target, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 45000);
  try {
    const r = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + BRIGHTDATA_API_KEY },
      body: JSON.stringify({ zone: BRIGHTDATA_ZONE, url: target, format: 'raw', country: (process.env.BRIGHTDATA_COUNTRY || 'kr') }),
      signal: ctrl.signal,
    });
    const html = await r.text();
    return { ok: r.ok, status: r.status, html, len: html.length, _bd: true };
  } catch (e) { return { ok: false, status: 0, html: '', len: 0, error: String(e && e.message || e), _bd: true }; }
  finally { clearTimeout(t); }
}
function proxyConfigured() { return brightDataConfigured() || !!buildProxyUrl('https://x', true); }

async function _fetchProxied(proxied, fwd) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  try {
    // 대상(네이버)으로 전달할 헤더: ScrapingBee 는 'Spb-' 프리픽스, ScraperAPI(keep_headers) 는 원본 그대로.
    const headers = { 'Accept': 'text/html,application/json,*/*', 'Accept-Language': 'ko-KR,ko;q=0.9' };
    if (fwd) for (const [k, v] of Object.entries(fwd)) { headers['Spb-' + k] = v; headers[k] = v; }
    const r = await fetch(proxied, { headers, signal: ctrl.signal });
    const html = await r.text();
    return { ok: r.ok, status: r.status, html, len: html.length };
  } catch (e) { return { ok: false, status: 0, html: '', len: 0, error: String(e && e.message || e) }; }
  finally { clearTimeout(t); }
}

async function tryProxyFetch(target, fwd) {
  // Bright Data 가 설정돼 있으면 우선 사용 (헤더는 Bright Data 가 알아서 처리)
  if (brightDataConfigured()) return tryBrightDataFetch(target);
  // 1) 지오타게팅(kr) 포함 시도 → 2) 무료플랜이 거부(4xx)하면 지오 없이 재시도
  let url = buildProxyUrl(target, true);
  if (!url) return { ok: false, status: 0, html: '', len: 0, error: 'no_proxy_key' };
  let r = await _fetchProxied(url, fwd);
  if (!r.ok && (r.status === 400 || r.status === 401 || r.status === 403)) {
    const noGeo = buildProxyUrl(target, false);
    if (noGeo && noGeo !== url) { const r2 = await _fetchProxied(noGeo, fwd); r2._retriedNoGeo = true; if (r2.ok || r2.len > r.len) r = r2; }
  }
  return r;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const q = (req.query && req.query.query) ? String(req.query.query).trim() : '';
  if (!q) { res.status(400).json({ error: 'query 파라미터 필수' }); return; }

  // 시도 순서: 1) 모바일 검색(차단 약함) 2) 데스크탑
  const attempts = [
    { label: 'mobile', isMobile: true, url: `https://m.search.shopping.naver.com/search/all?${new URLSearchParams({ query: q, frm: 'NVSHATC' }).toString()}` },
    { label: 'desktop', isMobile: false, url: `https://search.shopping.naver.com/search/all?${new URLSearchParams({ query: q, frm: 'NVSHATC' }).toString()}` },
  ];

  const diagnostics = [];
  const respond = (parsed, viaLabel) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).json({
      query: parsed.query || q,
      products: parsed.products,
      total: parsed.total || parsed.products.length,
      tabTotals: parsed.tabTotals || {},
      terms: parsed.terms || [],
      nluTerms: parsed.nluTerms || [],
      source: `${parsed.source}-${viaLabel}`,
    });
  };

  // 순위추적용 다중 페이지 — Bright Data 가 설정돼 있고 pages>1 이면 SERP 를 여러 페이지 병렬 조회해 합침
  //   GET /api/naver-shop-scrape?query=...&pages=5[&pagingSize=40]  → 상위 (pages×pagingSize)개
  const pagesN = Math.max(1, Math.min(6, parseInt(req.query && req.query.pages) || 1));
  if (pagesN > 1 && brightDataConfigured()) {
    const size = Math.max(20, Math.min(80, parseInt(req.query && req.query.pagingSize) || 40));
    const set = (req.query && req.query.productSet) ? String(req.query.productSet) : '';
    const urlFor = pg => {
      const sp = new URLSearchParams({ query: q, prevQuery: q, vertical: 'search', pagingIndex: String(pg), pagingSize: String(size), frm: 'NVSHATC' });
      if (set && set !== 'total') sp.set('productSet', set);
      return `https://search.shopping.naver.com/search/all?${sp.toString()}`;
    };
    const pageResults = await Promise.all(Array.from({ length: pagesN }, (_, i) => i + 1).map(async pg => {
            //  Web Unlocker 는 페이지당 20~40초 걸릴 수 있어(브라우저 렌더링 포함) 단일 시도에 52초 허용 — 모든 페이지를 병렬로 요청해 총 시간은 가장 느린 1건 기준.
      const t0 = Date.now();
      let r = null, parsed = null, tries = 0;
      for (; tries < 2; tries++) {
        const left = 57000 - (Date.now() - t0);
        if (left < 12000) break;
        r = await tryBrightDataFetch(urlFor(pg), Math.min(52000, left));
        if (r.ok && r.html && r.html.length > 5000) { parsed = parseProducts(r.html, q); if (parsed) break; }
      }
      r = r || { status: 0, len: 0, ok: false };
      const d = { via: 'proxy-multi', page: pg, status: r.status, len: r.len, ok: r.ok, tries: Math.min(tries + 1, 2), ms: Date.now() - t0 };
      if (r.error) d.error = r.error;
      if (!parsed) d.parsed = 'no products';
      return { pg, d, parsed };
    }));
    const seenIds = new Set(); const merged = [];
    for (const pr of pageResults.sort((x, y) => x.pg - y.pg)) {
      diagnostics.push(pr.d);
      if (!pr.parsed) continue;
      for (const o of pr.parsed.products) {
        const id = String(o.id || o.nvMid || o.mallProductId || o.productId || o.productTitle || '');
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        merged.push(o);
      }
    }
    if (merged.length) {
      const first = (pageResults.find(x => x.parsed) || {}).parsed || {};
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.status(200).json({ query: q, products: merged, total: merged.length, tabTotals: first.tabTotals || {}, terms: first.terms || [], nluTerms: first.nluTerms || [], source: 'obj-proxy-multi', pagesFetched: pageResults.filter(x => x.parsed).length, diagnostics });
      return;
    }
  }

  // 1단계: 직접 fetch (데이터센터 IP — 네이버가 차단할 수 있음: 418 등)
  for (const a of attempts) {
    try {
      const r = await tryFetch(a.url, a.isMobile);
      diagnostics.push({ via: 'direct', label: a.label, status: r.status, len: r.len, ok: r.ok });
      if (!r.ok || !r.html) continue;
      const parsed = parseProducts(r.html, q);
      if (parsed) { respond(parsed, `direct-${a.label}`); return; }
      diagnostics[diagnostics.length - 1].parsed = 'no products';
    } catch (e) {
      diagnostics.push({ via: 'direct', label: a.label, error: e.message || String(e) });
    }
  }

  // 2단계: 스크래핑 API 프록시 (주거용/우회 IP) — 키가 설정돼 있을 때만
  //   504(함수 타임아웃) 방지: 가벼운 내부 API(JSON) 1회 → 실패 시 데스크탑 SERP HTML 1회. (각 ≤22초)
  if (proxyConfigured()) {
    const serpRef = `https://search.shopping.naver.com/search/all?${new URLSearchParams({ query: q, frm: 'NVSHATC' }).toString()}`;
    // 요즘 데스크탑 SERP 는 상품을 클라이언트 JS 로 로드 → __NEXT_DATA__ 에 상품 없음.
    // 그래서 네이버 내부 JSON API 를 먼저 호출(상품 배열 바로 옴). Referer 를 forward_headers 로 전달해야 통과.
    const apiUrl = `https://search.shopping.naver.com/api/search/all?${new URLSearchParams({
      sort: 'rel', pagingIndex: '1', pagingSize: '40', viewType: 'list',
      productSet: 'total', query: q, frm: 'NVSHATC', origQuery: q, iq: '', eq: '', xq: '',
    }).toString()}`;
    const apiHeaders = { 'Referer': serpRef, 'User-Agent': UA_DESKTOP, 'Accept': 'application/json, text/plain, */*' };
    // 1) 내부 JSON API (가볍고 파싱 쉬움) → 2) 실패 시 SERP HTML 폴백
    // Bright Data 는 임의 헤더(Referer)를 전달하지 못하므로 SERP 페이지(HTML) 먼저, 내부 API 는 폴백
    const proxyTargets = brightDataConfigured()
      ? [
          { label: 'serp', url: serpRef, fwd: null },
          { label: 'api',  url: apiUrl,  fwd: null },
        ]
      : [
          { label: 'api',  url: apiUrl,   fwd: apiHeaders },
          { label: 'serp', url: serpRef,  fwd: { 'Referer': 'https://www.naver.com/', 'User-Agent': UA_DESKTOP } },
        ];
    // Bright Data: SERP 를 최대 2회(간헐적으로 상품이 빈 페이지가 내려옴) — 총 시간이 함수 한도(60초)를 넘지 않게 회당 27초 제한
    if (brightDataConfigured()) {
      const t0 = Date.now();
      for (let attempt = 0; attempt < 2; attempt++) {
        const left = 56000 - (Date.now() - t0);
        if (left < 10000) break;
        const r = await tryBrightDataFetch(serpRef, Math.min(27000, left));
        const d = { via: 'proxy', label: 'serp', attempt: attempt + 1, status: r.status, len: r.len, ok: r.ok, error: r.error, ms: Date.now() - t0 };
        diagnostics.push(d);
        if (!r.ok || !r.html) continue;
        const parsed = parseProducts(r.html, q);
        if (parsed) { respond(parsed, 'proxy-serp'); return; }
        d.parsed = 'no products';
        // 진단: 상품 없는 200 응답이 어떤 페이지인지 확인용(제목/앞부분 텍스트)
        try {
          const tm = r.html.match(/<title[^>]*>([^<]*)<\/title>/i);
          d.title = tm ? tm[1].slice(0, 80) : '';
          d.snip = r.html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
          d.hasNext = r.html.includes('__NEXT_DATA__'); d.hasTitleKey = r.html.includes('productTitle');
        } catch (_) {}
      }
    }
    for (const pt of (brightDataConfigured() ? [] : proxyTargets)) {
      try {
        const r = await tryProxyFetch(pt.url, pt.fwd);
        const d = { via: 'proxy', label: pt.label, status: r.status, len: r.len, ok: r.ok, error: r.error };
        if (!r.ok) d.body = (r.html || '').slice(0, 160);  // ScrapingBee 오류 메시지(크레딧 소진/키 오류 등) 노출
        diagnostics.push(d);
        if (!r.ok || !r.html) continue;
        const parsed = parseProducts(r.html, q);
        if (parsed) { respond(parsed, `proxy-${pt.label}`); return; }
        diagnostics[diagnostics.length - 1].parsed = 'no products';
      } catch (e) {
        diagnostics.push({ via: 'proxy', label: pt.label, error: e.message || String(e) });
      }
    }
  }

  // 전부 실패
  if (brightDataConfigured()) {
    // 진단용 — 키 값은 노출하지 않고 형태만 (길이/공백/curl 문구 포함 여부/영역 이름)
    diagnostics.push({ via: 'bd-config', keyLen: BRIGHTDATA_API_KEY.length, keyHasSpace: /\s/.test(BRIGHTDATA_API_KEY), keyLooksLikeCurl: /curl|Bearer|https?:/i.test(BRIGHTDATA_API_KEY), zone: BRIGHTDATA_ZONE });
  }
  res.status(502).json({
    error: '네이버 쇼핑 스크래핑 실패',
    proxyConfigured: proxyConfigured(),
    hint: proxyConfigured()
      ? '프록시 경유에도 실패 — 키 잔여 크레딧/응답을 diagnostics 에서 확인하세요.'
      : '서버 직접 접근은 네이버가 차단함. Vercel 환경변수에 SCRAPER_API_KEY(또는 SCRAPINGBEE_API_KEY)를 설정하면 프록시로 우회합니다.',
    diagnostics,
  });
}

export const config = {
  api: { bodyParser: false },
};
