// Vercel 서버리스 함수 — 네이버 스마트스토어 상품 정보 추출 (이미지/리뷰/평점/찜/등록일/태그)
// 호출: GET /api/smartstore-info?url=https://smartstore.naver.com/{mall}/products/{productId}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const q = req.query || {};
  let url = String(q.url || '').trim();
  if (!url) { res.status(400).json({ error: 'url 파라미터 필수' }); return; }
  if (!url.startsWith('http')) url = 'https://' + url;
  if (!url.includes('smartstore.naver.com') && !url.includes('brand.naver.com')) {
    res.status(400).json({ error: '네이버 스마트스토어/브랜드스토어 URL 만 지원' }); return;
  }

  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      },
    });
    if (!r.ok) {
      res.status(r.status).json({ error: '페이지 fetch 실패', status: r.status });
      return;
    }
    const html = await r.text();

    const out = parseSmartstoreHtml(html);
    out.url = url;
    res.setHeader('Cache-Control', 'public, max-age=300');  // 5분 캐시
    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
}

function parseSmartstoreHtml(html) {
  const result = {
    title: null, image: null, description: null,
    reviewCount: null, rating: null, wishCount: null,
    registDate: null, tags: [], category: null, price: null,
  };

  // 1) OG / 메타 태그
  const meta = (rx) => { const m = html.match(rx); return m ? decodeHtml(m[1].trim()) : null; };
  result.title       = meta(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
  result.image       = meta(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  result.description = meta(/<meta\s+property="og:description"\s+content="([^"]+)"/i);

  // 2) __PRELOADED_STATE__ / window.__INITIAL_STATE__ 등 JSON 블록 추출
  // 다양한 패턴 시도 — 스마트스토어 페이지 구조에 따라 다름
  const jsonPatterns = [
    /window\.__PRELOADED_STATE__\s*=\s*({[\s\S]+?})\s*;\s*<\/script>/,
    /window\.__INITIAL_STATE__\s*=\s*({[\s\S]+?})\s*;\s*<\/script>/,
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]+?)<\/script>/,
  ];
  let state = null;
  for (const p of jsonPatterns) {
    const m = html.match(p);
    if (m) { try { state = JSON.parse(m[1]); break; } catch(_) {} }
  }

  // 3) state 에서 가능한 필드들 추출 (구조가 자주 바뀌므로 여러 경로 시도)
  if (state) {
    const product = state?.product
      || state?.productDetail
      || state?.props?.pageProps?.initialState?.product
      || state?.initialState?.product
      || null;
    if (product) {
      result.title       = result.title || product.name || product.productName || null;
      result.image       = result.image || product.representativeImage || product.image || product.thumbnailImage || null;
      result.reviewCount = product.reviewCount ?? product.totalReviewCount ?? null;
      result.rating      = product.averageReviewScore ?? product.reviewAverageScore ?? null;
      result.wishCount   = product.wishListCount ?? product.zzimCount ?? product.likeCount ?? null;
      result.registDate  = product.regDate || product.registDate || product.regDateStr || null;
      result.price       = product.salePrice ?? product.dispSalePrice ?? product.price ?? null;
      const tagList = product.tags || product.searchTags || product.productTags || product.userSearchTags || [];
      if (Array.isArray(tagList)) {
        result.tags = tagList.map(t => (typeof t === 'string' ? t : (t?.text || t?.tagName || t?.name || ''))).filter(Boolean);
      }
      // 카테고리 (있으면)
      const cats = product.fullCategoryName || product.categoryFullName || product.wholeCategoryName || null;
      if (cats) result.category = cats;
    }
  }

  // 4) 정규식 fallback — JSON 못 찾았을 때 평점/리뷰 텍스트 패턴
  if (result.rating == null) {
    const m = html.match(/평점[\s\S]{0,30}?(\d+(?:\.\d+)?)\s*점/);
    if (m) result.rating = Number(m[1]);
  }
  if (result.reviewCount == null) {
    const m = html.match(/리뷰[\s\S]{0,20}?(\d+(?:,\d+)*)\s*개/);
    if (m) result.reviewCount = Number(m[1].replace(/,/g, ''));
  }
  if (result.wishCount == null) {
    const m = html.match(/찜[\s\S]{0,20}?(\d+(?:,\d+)*)\s*명?개?/);
    if (m) result.wishCount = Number(m[1].replace(/,/g, ''));
  }

  return result;
}

function decodeHtml(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

export const config = { api: { bodyParser: false } };
