// Vercel 서버리스 함수 — 네이버 스마트스토어 상품 정보 추출 (이미지/리뷰/평점/찜/등록일/태그)
// 호출: GET /api/smartstore-info?url=https://smartstore.naver.com/{mall}/products/{productId}
//
// 캐싱 흐름 (ROPAGO 식):
//   1) 요청 → Supabase smartstore_info_cache 에서 url 로 조회
//   2) 캐시 있고 만료 안 됨 → 즉시 반환 (네이버 fetch 안 함, 0.1초)
//   3) 캐시 없거나 만료 → 네이버 fetch → 의미있는 데이터면 캐시 저장 → 반환
//   4) 네이버 차단(429) → 만료된 캐시라도 있으면 반환 (정보 안 보이는 것보단 나음)
//
// 사전 준비: Supabase 대시보드에서 smartstore_cache_setup.sql 한 번 실행 필요

const SUPABASE_URL = 'https://gdsutxmceghvkemcfyuw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdkc3V0eG1jZWdodmtlbWNmeXV3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5ODc0MDEsImV4cCI6MjA5MTU2MzQwMX0.yO_UwxtQVtVBLC2dVsmJQ4_qgOuWl5LBVAbsnmlwq1U';
const CACHE_TTL_DAYS = 7;

// Supabase REST API helpers (의존성 없이 fetch 만 사용)
async function _cacheRead(url) {
  try {
    const endpoint = `${SUPABASE_URL}/rest/v1/smartstore_info_cache?url=eq.${encodeURIComponent(url)}&select=data,fetched_at,expires_at`;
    const r = await fetch(endpoint, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
        Accept: 'application/json',
      },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows[0]; // { data, fetched_at, expires_at }
  } catch (e) {
    console.warn('[smartstore-info] cache read failed:', e.message || e);
    return null;
  }
}

async function _cacheWrite(url, data) {
  try {
    const expiresAt = new Date(Date.now() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const endpoint = `${SUPABASE_URL}/rest/v1/smartstore_info_cache`;
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates', // url 중복이면 upsert
      },
      body: JSON.stringify({
        url,
        data,
        fetched_at: new Date().toISOString(),
        expires_at: expiresAt,
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.warn('[smartstore-info] cache write HTTP', r.status, txt.slice(0, 200));
    }
  } catch (e) {
    console.warn('[smartstore-info] cache write failed:', e.message || e);
  }
}

// 네이버 스마트스토어 내부 JSON API 시도 — 여러 endpoint 차례로
// 성공하면 HTML fetch 보다 훨씬 빠름 (1~2초), 차단도 덜할 수 있음 (다른 endpoint)
async function _tryNaverInternalAPI(productUrl) {
  // URL 에서 channelName + productId 추출
  const m = productUrl.match(/(?:smartstore|brand)\.naver\.com\/([^/?#]+)\/products\/(\d+)/);
  if (!m) return null;
  const channelName = m[1];
  const productId = m[2];

  const commonHeaders = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': productUrl,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'X-Client-Version': 'PC',
  };

  // ⭐ 1차: 리뷰 요약 (reviewCount, averageReviewScore) — 가장 가벼운 endpoint
  const reviewSummaryUrl = `https://smartstore.naver.com/i/v1/contents/reviews/product-summary/${productId}`;
  // ⭐ 2차: 리뷰 태그 (relevant tags from reviews)
  const reviewTagsUrl = `https://smartstore.naver.com/i/v1/contents/reviews/summary-tag/${productId}`;

  const result = {
    title: null, image: null, description: null,
    reviewCount: null, rating: null, wishCount: null,
    registDate: null, tags: [], category: null, price: null,
  };

  // 리뷰 요약 + 태그를 병렬 fetch
  const fetches = [
    fetch(reviewSummaryUrl, { headers: commonHeaders }).then(async r => {
      console.log('[smartstore-info] review-summary →', r.status);
      if (!r.ok) return null;
      const ct = r.headers.get('content-type') || '';
      if (!ct.toLowerCase().includes('json')) return null;
      return r.json();
    }).catch(() => null),
    fetch(reviewTagsUrl, { headers: commonHeaders }).then(async r => {
      console.log('[smartstore-info] review-tags →', r.status);
      if (!r.ok) return null;
      const ct = r.headers.get('content-type') || '';
      if (!ct.toLowerCase().includes('json')) return null;
      return r.json();
    }).catch(() => null),
  ];

  const [reviewSummary, reviewTags] = await Promise.all(fetches);

  // 리뷰 요약 응답 파싱
  if (reviewSummary && typeof reviewSummary === 'object') {
    const pri = reviewSummary.productReviewInfo;
    if (pri && typeof pri === 'object') {
      if (pri.reviewCount != null) result.reviewCount = Number(pri.reviewCount);
      if (pri.averageReviewScore != null) result.rating = Number(pri.averageReviewScore);
    }
    const rpri = reviewSummary.recentProductReviewInfo;
    if (rpri && typeof rpri === 'object') {
      if (result.reviewCount == null && rpri.recentReviewCount != null) result.reviewCount = Number(rpri.recentReviewCount);
      if (result.rating == null && rpri.recentAverageReviewScore != null) result.rating = Number(rpri.recentAverageReviewScore);
    }
  }

  // 리뷰 태그 응답 파싱 — [{tagGroupNo, representTagName, ...}, ...]
  if (Array.isArray(reviewTags) && reviewTags.length) {
    const tagSet = new Set();
    for (const t of reviewTags) {
      const name = t && (t.representTagName || t.tagName || t.name);
      if (name && typeof name === 'string') tagSet.add(name.trim());
    }
    if (tagSet.size) result.tags = [...tagSet].slice(0, 12);
  }

  if (_hasMeaningfulData(result)) {
    result._source = 'naver-internal-api';
    result._endpoints = [reviewSummaryUrl, reviewTagsUrl];
    return result;
  }
  return null;
}

// 네이버 내부 API 응답을 파싱 — product 객체 깊이 탐색
function _parseNaverApiResponse(data) {
  const result = {
    title: null, image: null, description: null,
    reviewCount: null, rating: null, wishCount: null,
    registDate: null, tags: [], category: null, price: null,
  };

  // ⭐ /i/v1/contents/reviews/product-summary/{id} 응답 형식 — 리뷰/평점 전용
  // { productReviewInfo: {reviewCount, averageReviewScore, ...}, recentProductReviewInfo: {...}, reviewTopics: [...] }
  if (data && typeof data === 'object') {
    const pri = data.productReviewInfo;
    if (pri && typeof pri === 'object') {
      if (pri.reviewCount != null) result.reviewCount = Number(pri.reviewCount);
      if (pri.averageReviewScore != null) result.rating = Number(pri.averageReviewScore);
    }
    const rpri = data.recentProductReviewInfo;
    if (rpri && typeof rpri === 'object') {
      // recent 가 더 최신이면 우선 적용 (보통 더 정확)
      if (result.reviewCount == null && rpri.recentReviewCount != null) result.reviewCount = Number(rpri.recentReviewCount);
      if (result.rating == null && rpri.recentAverageReviewScore != null) result.rating = Number(rpri.recentAverageReviewScore);
    }
  }
  function findProduct(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 8) return null;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length && i < 100; i++) {
        const r = findProduct(obj[i], depth + 1);
        if (r) return r;
      }
      return null;
    }
    const looksLikeProduct = (
      (obj.name || obj.productName) &&
      (obj.reviewCount != null || obj.totalReviewCount != null ||
       obj.averageReviewScore != null || obj.reviewAverageScore != null ||
       obj.wishListCount != null || obj.zzimCount != null ||
       obj.regDate || obj.registDate)
    );
    if (looksLikeProduct) return obj;
    for (const k in obj) {
      const v = obj[k];
      if (v && typeof v === 'object') {
        const r = findProduct(v, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }
  const product = findProduct(data, 0) || data;
  if (product && typeof product === 'object') {
    result.title       = product.name || product.productName || null;
    result.image       = product.representativeImage || product.representImage || product.image || product.thumbnailImage || null;
    if (typeof result.image === 'object' && result.image) {
      result.image = result.image.url || result.image.src || null;
    }
    result.description = product.description || product.shortDescription || null;
    result.reviewCount = product.reviewCount ?? product.totalReviewCount ?? null;
    result.rating      = product.averageReviewScore ?? product.reviewAverageScore ?? product.rating ?? null;
    result.wishCount   = product.wishListCount ?? product.zzimCount ?? product.likeCount ?? product.interestCount ?? null;
    result.registDate  = product.regDate || product.registDate || product.regDateStr || product.registrationDate || null;
    result.price       = product.salePrice ?? product.dispSalePrice ?? product.price ?? null;
    const tagList = product.tags || product.searchTags || product.productTags || product.userSearchTags || product.tagList || [];
    if (Array.isArray(tagList) && tagList.length) {
      result.tags = tagList.map(t => (typeof t === 'string' ? t : (t && (t.text || t.tagName || t.name)) || '')).filter(Boolean);
    }
    const cats = product.fullCategoryName || product.categoryFullName || product.wholeCategoryName || product.category;
    if (cats) {
      result.category = typeof cats === 'string' ? cats : (Array.isArray(cats) ? cats.join(' > ') : (cats.name || null));
    }
  }
  // registDate 정규화
  if (result.registDate) {
    result.registDate = String(result.registDate).slice(0, 10).replace(/[.\/]/g, '-');
  }
  return result;
}

function _hasMeaningfulData(out) {
  // 리뷰/평점/찜/등록일/태그 중 최소 2개 있어야 캐싱 (부실 데이터 캐싱 방지)
  // title/image 만 있는 경우는 캐싱하지 않음 — 다음번에 다시 시도하면 더 풍부한 데이터 가능
  let cnt = 0;
  if (out.reviewCount != null) cnt++;
  if (out.rating != null) cnt++;
  if (out.wishCount != null) cnt++;
  if (out.registDate) cnt++;
  if (Array.isArray(out.tags) && out.tags.length) cnt++;
  return cnt >= 2;
}

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

  const bypassCache = String(q.refresh || '') === '1';  // ?refresh=1 이면 캐시 무시

  // 1) 캐시 우선 조회
  let cached = null;
  if (!bypassCache) {
    cached = await _cacheRead(url);
    if (cached) {
      const fresh = new Date(cached.expires_at) > new Date();
      if (fresh) {
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('Cache-Control', 'public, max-age=1800');
        res.status(200).json({ ...cached.data, _cached: true, _cachedAt: cached.fetched_at });
        return;
      }
    }
  }

  // 2-A) 네이버 내부 JSON API 먼저 시도 (HTML fetch 보다 빠름, 차단도 덜할 수 있음)
  try {
    const internal = await _tryNaverInternalAPI(url);
    if (internal && _hasMeaningfulData(internal)) {
      internal.url = url;
      _cacheWrite(url, internal).catch(() => {});
      res.setHeader('X-Cache', 'MISS-API');
      res.setHeader('Cache-Control', 'public, max-age=1800');
      res.status(200).json(internal);
      return;
    }
  } catch (e) {
    console.log('[smartstore-info] internal API 시도 실패:', e?.message || e);
  }

  // 2-B) 내부 API 실패 → HTML fetch 폴백 (기존 방식)
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      },
    });
    if (!r.ok) {
      // 네이버 차단 시 — 만료된 캐시라도 있으면 그걸 반환 (정보 안 보이는 것보단 나음)
      if (cached) {
        res.setHeader('X-Cache', 'STALE');
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.status(200).json({ ...cached.data, _cached: true, _stale: true, _cachedAt: cached.fetched_at });
        return;
      }
      res.status(r.status).json({ error: '페이지 fetch 실패', status: r.status });
      return;
    }
    const html = await r.text();

    const out = parseSmartstoreHtml(html);
    out.url = url;

    // 3) 의미있는 데이터면 캐시 저장 (백그라운드 — await 안 함)
    if (_hasMeaningfulData(out)) {
      _cacheWrite(url, out).catch(() => {});
    }

    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 'public, max-age=1800');  // 30분 브라우저 캐시
    res.status(200).json(out);
  } catch (err) {
    // 예외 발생 시도 — 만료 캐시라도 있으면 반환
    if (cached) {
      res.setHeader('X-Cache', 'STALE');
      res.status(200).json({ ...cached.data, _cached: true, _stale: true, _cachedAt: cached.fetched_at });
      return;
    }
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
            // ratingCount(별점만 매긴 수) 는 실제 리뷰 수와 다를 수 있어 fallback 제거
            if (ar.reviewCount != null) result.reviewCount = result.reviewCount ?? Number(ar.reviewCount);
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
