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
    res.setHeader('Cache-Control', 'public, max-age=1800');  // 30분 캐시 (네이버 rate limit 회피)
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
    _debug: { foundState: false, jsonLd: 0, htmlLen: html.length },
  };

  // 1) OG / 메타 태그
  const meta = (rx) => { const m = html.match(rx); return m ? decodeHtml(m[1].trim()) : null; };
  result.title       = meta(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  result.image       = meta(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
  result.description = meta(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);

  // 2) JSON-LD 추출 (대부분의 스마트스토어 페이지에 있음)
  const ldMatches = html.match(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]+?)<\/script>/gi) || [];
  result._debug.jsonLd = ldMatches.length;
  for (const m of ldMatches) {
    try {
      const inner = m.replace(/<script[^>]*>|<\/script>/gi, '');
      const obj = JSON.parse(inner);
      // 단일 객체 / 배열 모두 처리
      const items = Array.isArray(obj) ? obj : [obj];
      for (const o of items) {
        const t = o['@type'];
        if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) {
          result.title = result.title || o.name || null;
          if (o.image) {
            const img = Array.isArray(o.image) ? o.image[0] : o.image;
            result.image = result.image || img;
          }
          result.description = result.description || o.description || null;
          if (o.aggregateRating) {
            const ar = o.aggregateRating;
            if (ar.ratingValue != null) result.rating = result.rating ?? Number(ar.ratingValue);
            if (ar.reviewCount != null) result.reviewCount = result.reviewCount ?? Number(ar.reviewCount);
            else if (ar.ratingCount != null) result.reviewCount = result.reviewCount ?? Number(ar.ratingCount);
          }
          if (o.offers) {
            const offer = Array.isArray(o.offers) ? o.offers[0] : o.offers;
            if (offer && offer.price != null) result.price = result.price ?? Number(offer.price);
          }
          if (o.category) result.category = result.category || (Array.isArray(o.category) ? o.category.join(' > ') : o.category);
        }
        // BreadcrumbList 처리 — 카테고리 경로
        if (t === 'BreadcrumbList' || (Array.isArray(t) && t.includes('BreadcrumbList'))) {
          if (Array.isArray(o.itemListElement)) {
            const cats = o.itemListElement
              .map(el => el.name || el.item?.name || '')
              .filter(Boolean);
            if (cats.length && !result.category) result.category = cats.join(' > ');
          }
        }
      }
    } catch(_) {}
  }

  // 3) __PRELOADED_STATE__ / __NEXT_DATA__ JSON 블록
  const jsonPatterns = [
    /window\.__PRELOADED_STATE__\s*=\s*({[\s\S]+?})\s*;\s*<\/script>/,
    /window\.__INITIAL_STATE__\s*=\s*({[\s\S]+?})\s*;\s*<\/script>/,
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]+?)<\/script>/,
  ];
  let state = null;
  for (const p of jsonPatterns) {
    const m = html.match(p);
    if (m) { try { state = JSON.parse(m[1]); result._debug.foundState = true; break; } catch(_) {} }
  }

  // state 트리 깊이 탐색 — product 객체를 찾음
  function findProductIn(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 6) return null;
    // 휴리스틱: name + reviewCount/totalReviewCount 등이 있으면 product 로 간주
    const looksLikeProduct = (
      (obj.name || obj.productName) &&
      (obj.reviewCount != null || obj.totalReviewCount != null ||
       obj.averageReviewScore != null || obj.reviewAverageScore != null ||
       obj.wishListCount != null || obj.zzimCount != null ||
       obj.regDate || obj.registDate)
    );
    if (looksLikeProduct) return obj;
    for (const k in obj) {
      if (!obj.hasOwnProperty(k)) continue;
      const v = obj[k];
      if (v && typeof v === 'object') {
        const found = findProductIn(v, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  if (state) {
    const product = findProductIn(state, 0);
    if (product) {
      result.title       = result.title || product.name || product.productName || null;
      result.image       = result.image || product.representativeImage || product.representImage || product.image || product.thumbnailImage || null;
      result.reviewCount = result.reviewCount ?? product.reviewCount ?? product.totalReviewCount ?? null;
      result.rating      = result.rating ?? product.averageReviewScore ?? product.reviewAverageScore ?? null;
      result.wishCount   = result.wishCount ?? product.wishListCount ?? product.zzimCount ?? product.likeCount ?? null;
      result.registDate  = result.registDate || product.regDate || product.registDate || product.regDateStr || null;
      result.price       = result.price ?? product.salePrice ?? product.dispSalePrice ?? product.price ?? null;
      const tagList = product.tags || product.searchTags || product.productTags || product.userSearchTags || [];
      if (Array.isArray(tagList) && tagList.length) {
        result.tags = tagList.map(t => (typeof t === 'string' ? t : (t?.text || t?.tagName || t?.name || ''))).filter(Boolean);
      }
      const cats = product.fullCategoryName || product.categoryFullName || product.wholeCategoryName;
      if (cats && !result.category) result.category = cats;
    }
  }

  // 4) 정규식 fallback — HTML 텍스트 패턴
  if (result.rating == null) {
    const m = html.match(/(?:평균\s*)?평점\s*:?\s*(\d+\.\d+)/) || html.match(/별점[\s\S]{0,30}?(\d+(?:\.\d+)?)\s*점/);
    if (m) result.rating = Number(m[1]);
  }
  if (result.reviewCount == null) {
    const m = html.match(/리뷰\s*\(?\s*(\d+(?:,\d+)*)/) || html.match(/총리뷰\s*(\d+(?:,\d+)*)/);
    if (m) result.reviewCount = Number(m[1].replace(/,/g, ''));
  }
  if (result.wishCount == null) {
    const m = html.match(/찜\s*\(?\s*(\d+(?:,\d+)*)/) || html.match(/관심상품[\s\S]{0,20}?(\d+(?:,\d+)*)/);
    if (m) result.wishCount = Number(m[1].replace(/,/g, ''));
  }
  if (result.registDate == null) {
    const m = html.match(/등록일\s*:?\s*(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2})/);
    if (m) result.registDate = m[1].replace(/[.\/]/g, '-');
  }

  return result;
}

function decodeHtml(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

export const config = { api: { bodyParser: false } };
