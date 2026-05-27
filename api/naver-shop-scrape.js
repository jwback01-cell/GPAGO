// Vercel 서버리스 함수 — 네이버 쇼핑 검색 페이지 HTML 에서 shoppingResult JSON 직접 추출
// 호출: GET /api/naver-shop-scrape?query=버즈4+프로+케이스
// 응답: { query, products: [...], terms: [...], total, source }
// 비고: 개발자도구로 JSON 복사 없이 키워드만으로 마누태그 추출 가능 (ROPAGO 방식)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// HTML 안의 <script id="__NEXT_DATA__" ...>{json}</script> 형태에서 JSON 추출
function extractNextData(html) {
  const m = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (_) { return null; }
}

// __NEXT_DATA__ 트리 안에서 products 배열이 있는 노드를 찾음
function findProducts(obj, depth) {
  if (!obj || typeof obj !== 'object' || depth > 8) return null;
  // shoppingResult 형태
  if (obj.shoppingResult && Array.isArray(obj.shoppingResult.products)) {
    return { products: obj.shoppingResult.products, total: obj.shoppingResult.total || 0, terms: obj.shoppingResult.terms || obj.terms || [], nluTerms: obj.shoppingResult.nluTerms || obj.nluTerms || [], query: obj.shoppingResult.query || obj.query || '' };
  }
  // products 배열 직접 보유
  if (Array.isArray(obj.products) && obj.products.length && typeof obj.products[0] === 'object' && ('manuTag' in obj.products[0] || 'productTitle' in obj.products[0] || 'productName' in obj.products[0])) {
    return { products: obj.products, total: obj.total || 0, terms: obj.terms || [], nluTerms: obj.nluTerms || [], query: obj.query || '' };
  }
  for (const k of Object.keys(obj)) {
    const found = findProducts(obj[k], depth + 1);
    if (found) return found;
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const q = (req.query && req.query.query) ? String(req.query.query).trim() : '';
  if (!q) { res.status(400).json({ error: 'query 파라미터 필수' }); return; }

  const url = `https://search.shopping.naver.com/search/all?${new URLSearchParams({ query: q, frm: 'NVSHATC' }).toString()}`;

  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        'Referer': 'https://www.naver.com/',
      },
    });
    if (!r.ok) {
      res.status(r.status).json({ error: '네이버 쇼핑 페이지 호출 실패', detail: `HTTP ${r.status}` });
      return;
    }
    const html = await r.text();

    const nextData = extractNextData(html);
    let scope = null;
    if (nextData) {
      scope = findProducts(nextData.props, 0) || findProducts(nextData, 0);
    }
    // __NEXT_DATA__ 추출 실패 시 manuTag 만이라도 정규식으로 긁기
    if (!scope || !scope.products || !scope.products.length) {
      const products = [];
      const manuRe = /"manuTag"\s*:\s*"([^"]*)"/g;
      const titleRe = /"productTitle"\s*:\s*"([^"]*)"/g;
      const tags = [];
      let m;
      while ((m = manuRe.exec(html)) !== null) tags.push(m[1] || '');
      const titles = [];
      while ((m = titleRe.exec(html)) !== null) titles.push(m[1] || '');
      const len = Math.max(tags.length, titles.length);
      for (let i = 0; i < len; i++) {
        products.push({ manuTag: tags[i] || '', productTitle: titles[i] || '', _rank: i + 1 });
      }
      if (!products.length) {
        res.status(502).json({ error: '상품 데이터 추출 실패', hint: '네이버가 페이지 구조를 바꿨거나 봇 차단함' });
        return;
      }
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.status(200).json({ query: q, products, total: products.length, terms: [], nluTerms: [], source: 'regex-fallback' });
      return;
    }

    res.setHeader('Cache-Control', 'public, max-age=300'); // 5분 캐시
    res.status(200).json({
      query: scope.query || q,
      products: scope.products,
      total: scope.total || scope.products.length,
      terms: scope.terms || [],
      nluTerms: scope.nluTerms || [],
      source: 'next-data',
    });
  } catch (err) {
    console.error('[naver-shop-scrape] 실패:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
}

export const config = {
  api: { bodyParser: false },
};
