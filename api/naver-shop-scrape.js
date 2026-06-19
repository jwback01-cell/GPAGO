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

// HTML(또는 JSON 문자열)에서 products 추출 — 직접/프록시 공용
function parseProducts(html, q) {
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
function buildProxyUrl(target, withGeo) {
  const geo = process.env.SCRAPER_API_COUNTRY || 'kr';
  if (process.env.SCRAPER_API_KEY) {
    const p = { api_key: process.env.SCRAPER_API_KEY, url: target, keep_headers: 'true' };
    if (withGeo && geo && geo !== 'none') p.country_code = geo;
    return 'https://api.scraperapi.com/?' + new URLSearchParams(p).toString();
  }
  if (process.env.SCRAPINGBEE_API_KEY) {
    const p = { api_key: process.env.SCRAPINGBEE_API_KEY, url: target, render_js: 'false' };
    if (withGeo && geo && geo !== 'none') p.country_code = geo;
    return 'https://app.scrapingbee.com/api/v1/?' + new URLSearchParams(p).toString();
  }
  if (process.env.SCRAPE_PROXY_URL) {
    const tpl = process.env.SCRAPE_PROXY_URL;
    return tpl.includes('{url}') ? tpl.replace('{url}', encodeURIComponent(target)) : tpl + encodeURIComponent(target);
  }
  return null;
}
function proxyConfigured() { return !!buildProxyUrl('https://x', true); }

async function _fetchProxied(proxied) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(proxied, { headers: { 'Accept': 'text/html,application/json,*/*', 'Accept-Language': 'ko-KR,ko;q=0.9' }, signal: ctrl.signal });
    const html = await r.text();
    return { ok: r.ok, status: r.status, html, len: html.length };
  } catch (e) { return { ok: false, status: 0, html: '', len: 0, error: String(e && e.message || e) }; }
  finally { clearTimeout(t); }
}

async function tryProxyFetch(target) {
  // 1) 지오타게팅(kr) 포함 시도 → 2) 무료플랜이 거부(4xx)하면 지오 없이 재시도
  let url = buildProxyUrl(target, true);
  if (!url) return { ok: false, status: 0, html: '', len: 0, error: 'no_proxy_key' };
  let r = await _fetchProxied(url);
  if (!r.ok && (r.status === 400 || r.status === 401 || r.status === 403)) {
    const noGeo = buildProxyUrl(target, false);
    if (noGeo && noGeo !== url) { const r2 = await _fetchProxied(noGeo); r2._retriedNoGeo = true; if (r2.ok || r2.len > r.len) r = r2; }
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
  if (proxyConfigured()) {
    for (const a of attempts) {
      try {
        const r = await tryProxyFetch(a.url);
        diagnostics.push({ via: 'proxy', label: a.label, status: r.status, len: r.len, ok: r.ok, error: r.error });
        if (!r.ok || !r.html) continue;
        const parsed = parseProducts(r.html, q);
        if (parsed) { respond(parsed, `proxy-${a.label}`); return; }
        diagnostics[diagnostics.length - 1].parsed = 'no products';
      } catch (e) {
        diagnostics.push({ via: 'proxy', label: a.label, error: e.message || String(e) });
      }
    }
  }

  // 전부 실패
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
