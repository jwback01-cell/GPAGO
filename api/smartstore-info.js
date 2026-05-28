// 진단 버전 2 — fetch 만, parsing 없음
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = String((req.query && req.query.url) || '').trim();
  if (!url) { res.status(400).json({ error: 'url required' }); return; }
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    res.status(200).json({ ok: true, url, status: r.status, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
