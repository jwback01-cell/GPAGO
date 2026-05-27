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
  for (const a of attempts) {
    try {
      const r = await tryFetch(a.url, a.isMobile);
      diagnostics.push({ label: a.label, status: r.status, len: r.len, ok: r.ok });
      if (!r.ok || !r.html) continue;

      // 1) __NEXT_DATA__ 시도
      const nextData = extractNextData(r.html);
      let scope = null;
      if (nextData) {
        scope = findProducts(nextData.props, 0) || findProducts(nextData, 0);
      }
      if (scope && scope.products && scope.products.length) {
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.status(200).json({
          query: scope.query || q,
          products: scope.products,
          total: scope.total || scope.products.length,
          terms: scope.terms || [],
          nluTerms: scope.nluTerms || [],
          source: `next-data-${a.label}`,
        });
        return;
      }
      // 2) 정규식 폴백
      const products = regexFallback(r.html);
      if (products.length) {
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.status(200).json({
          query: q,
          products,
          total: products.length,
          terms: [],
          nluTerms: [],
          source: `regex-${a.label}`,
        });
        return;
      }
      diagnostics[diagnostics.length - 1].parsed = 'no products';
    } catch (e) {
      diagnostics.push({ label: a.label, error: e.message || String(e) });
    }
  }

  // 전부 실패
  res.status(502).json({
    error: '네이버 쇼핑 스크래핑 실패',
    hint: '네이버가 봇 접근을 차단했을 가능성 — 대안: 상품 제목 기반 폴백 모드 또는 직접 JSON 붙여넣기 사용',
    diagnostics,
  });
}

export const config = {
  api: { bodyParser: false },
};
