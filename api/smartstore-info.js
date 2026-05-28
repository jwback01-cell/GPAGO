// Vercel 서버리스 함수 - 네이버 스마트스토어 상품 정보 추출
// GET /api/smartstore-info?url=https://smartstore.naver.com/{mall}/products/{id}

const SUPABASE_URL = 'https://gdsutxmceghvkemcfyuw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdkc3V0eG1jZWdodmtlbWNmeXV3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5ODc0MDEsImV4cCI6MjA5MTU2MzQwMX0.yO_UwxtQVtVBLC2dVsmJQ4_qgOuWl5LBVAbsnmlwq1U';
const CACHE_TTL_DAYS = 7;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function cacheRead(url) {
  try {
    const ep = SUPABASE_URL + '/rest/v1/smartstore_info_cache?url=eq.' + encodeURIComponent(url) + '&select=data,fetched_at,expires_at';
    const r = await fetch(ep, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
        Accept: 'application/json',
      },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return (Array.isArray(rows) && rows.length) ? rows[0] : null;
  } catch (e) {
    return null;
  }
}

async function cacheWrite(url, data) {
  try {
    const expiresAt = new Date(Date.now() + CACHE_TTL_DAYS * 86400000).toISOString();
    const ep = SUPABASE_URL + '/rest/v1/smartstore_info_cache';
    await fetch(ep, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        url,
        data,
        fetched_at: new Date().toISOString(),
        expires_at: expiresAt,
      }),
    });
  } catch (e) {}
}

function hasMeaningful(out) {
  let cnt = 0;
  if (out.reviewCount != null) cnt++;
  if (out.rating != null) cnt++;
  if (out.wishCount != null) cnt++;
  if (out.registDate) cnt++;
  if (Array.isArray(out.tags) && out.tags.length) cnt++;
  return cnt >= 2;
}

async function tryInternalAPI(productUrl) {
  const m = productUrl.match(/(?:smartstore|brand)\.naver\.com\/([^/?#]+)\/products\/(\d+)/);
  if (!m) return null;
  const productId = m[2];
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
    'User-Agent': UA,
    Referer: productUrl,
  };
  const result = {
    title: null, image: null, description: null,
    reviewCount: null, rating: null, wishCount: null,
    registDate: null, tags: [], category: null, price: null,
  };
  try {
    const r = await fetch('https://smartstore.naver.com/i/v1/contents/reviews/product-summary/' + productId, { headers });
    if (r.ok) {
      const ct = String(r.headers.get('content-type') || '').toLowerCase();
      if (ct.indexOf('json') !== -1) {
        const data = await r.json();
        const pri = data && data.productReviewInfo;
        if (pri) {
          if (pri.reviewCount != null) result.reviewCount = Number(pri.reviewCount);
          if (pri.averageReviewScore != null) result.rating = Number(pri.averageReviewScore);
        }
      }
    }
  } catch (e) {}
  try {
    const r = await fetch('https://smartstore.naver.com/i/v1/contents/reviews/summary-tag/' + productId, { headers });
    if (r.ok) {
      const ct = String(r.headers.get('content-type') || '').toLowerCase();
      if (ct.indexOf('json') !== -1) {
        const data = await r.json();
        if (Array.isArray(data) && data.length) {
          const tags = [];
          for (let i = 0; i < data.length; i++) {
            const t = data[i];
            const name = t && (t.representTagName || t.tagName || t.name);
            if (name && typeof name === 'string') tags.push(name.trim());
          }
          if (tags.length) result.tags = tags.slice(0, 12);
        }
      }
    }
  } catch (e) {}
  return hasMeaningful(result) ? result : null;
}

function decodeHtml(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

function parseHtml(html) {
  const result = {
    title: null, image: null, description: null,
    reviewCount: null, rating: null, wishCount: null,
    registDate: null, tags: [], category: null, price: null,
  };
  const meta = (rx) => { const m = html.match(rx); return m ? decodeHtml(m[1].trim()) : null; };
  result.title = meta(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  result.image = meta(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
  result.description = meta(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
  // JSON-LD
  const ldMatches = html.match(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]+?)<\/script>/gi) || [];
  for (const m of ldMatches) {
    try {
      const obj = JSON.parse(m.replace(/<script[^>]*>|<\/script>/gi, ''));
      const items = Array.isArray(obj) ? obj : [obj];
      for (const o of items) {
        const t = o['@type'];
        if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) {
          result.title = result.title || o.name || null;
          if (o.image) {
            const img = Array.isArray(o.image) ? o.image[0] : o.image;
            result.image = result.image || img;
          }
          if (o.aggregateRating) {
            const ar = o.aggregateRating;
            if (ar.ratingValue != null) result.rating = result.rating == null ? Number(ar.ratingValue) : result.rating;
            if (ar.reviewCount != null) result.reviewCount = result.reviewCount == null ? Number(ar.reviewCount) : result.reviewCount;
          }
          if (o.offers) {
            const offer = Array.isArray(o.offers) ? o.offers[0] : o.offers;
            if (offer && offer.price != null) result.price = result.price == null ? Number(offer.price) : result.price;
          }
          if (o.category && !result.category) result.category = Array.isArray(o.category) ? o.category.join(' > ') : o.category;
        }
        if (t === 'BreadcrumbList' || (Array.isArray(t) && t.includes('BreadcrumbList'))) {
          if (Array.isArray(o.itemListElement)) {
            const cats = o.itemListElement.map(el => el.name || (el.item && el.item.name) || '').filter(Boolean);
            if (cats.length && !result.category) result.category = cats.join(' > ');
          }
        }
      }
    } catch (_) {}
  }
  // regex fallback
  if (result.rating == null) {
    const m = html.match(/평점\s*:?\s*(\d+\.\d+)/);
    if (m) result.rating = Number(m[1]);
  }
  if (result.reviewCount == null) {
    const m = html.match(/리뷰\s*\(?\s*(\d+(?:,\d+)*)/);
    if (m) result.reviewCount = Number(m[1].replace(/,/g, ''));
  }
  if (result.wishCount == null) {
    const m = html.match(/찜\s*\(?\s*(\d+(?:,\d+)*)/);
    if (m) result.wishCount = Number(m[1].replace(/,/g, ''));
  }
  if (result.registDate == null) {
    const m = html.match(/등록일\s*:?\s*(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2})/);
    if (m) result.registDate = m[1].replace(/[.\/]/g, '-');
  }
  return result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const q = req.query || {};
  let url = String(q.url || '').trim();
  if (!url) { res.status(400).json({ error: 'url 필수' }); return; }
  if (!url.startsWith('http')) url = 'https://' + url;
  if (!url.includes('smartstore.naver.com') && !url.includes('brand.naver.com')) {
    res.status(400).json({ error: '스마트스토어/브랜드스토어 URL 만 지원' });
    return;
  }
  const bypassCache = String(q.refresh || '') === '1';

  let cached = null;
  if (!bypassCache) {
    cached = await cacheRead(url);
    if (cached) {
      const fresh = new Date(cached.expires_at) > new Date();
      if (fresh) {
        res.setHeader('X-Cache', 'HIT');
        res.status(200).json({ ...cached.data, _cached: true, _cachedAt: cached.fetched_at });
        return;
      }
    }
  }

  try {
    const internal = await tryInternalAPI(url);
    if (internal && hasMeaningful(internal)) {
      internal.url = url;
      cacheWrite(url, internal).catch(() => {});
      res.setHeader('X-Cache', 'MISS-API');
      res.status(200).json(internal);
      return;
    }
  } catch (e) {}

  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      },
    });
    if (!r.ok) {
      if (cached) {
        res.setHeader('X-Cache', 'STALE');
        res.status(200).json({ ...cached.data, _cached: true, _stale: true, _cachedAt: cached.fetched_at });
        return;
      }
      res.status(r.status).json({ error: '페이지 fetch 실패', status: r.status });
      return;
    }
    const html = await r.text();
    const out = parseHtml(html);
    out.url = url;
    if (hasMeaningful(out)) cacheWrite(url, out).catch(() => {});
    res.setHeader('X-Cache', 'MISS');
    res.status(200).json(out);
  } catch (err) {
    if (cached) {
      res.setHeader('X-Cache', 'STALE');
      res.status(200).json({ ...cached.data, _cached: true, _stale: true, _cachedAt: cached.fetched_at });
      return;
    }
    res.status(500).json({ error: err.message || String(err) });
  }
}
