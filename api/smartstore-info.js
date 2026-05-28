// 진단 v4 - fetch + parseHtml + JSON-LD 파싱
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
  return result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = String((req.query && req.query.url) || '').trim();
  if (!url) { res.status(400).json({ error: 'url required' }); return; }
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    const html = await r.text();
    const out = parseHtml(html);
    out.url = url;
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
