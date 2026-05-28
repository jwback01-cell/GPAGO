// 진단 v3 - fetch + parseHtml (JSON-LD 파싱)
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
