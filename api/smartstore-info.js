// 최소 버전 — 단순히 url 파라미터를 받아 echo
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = String((req.query && req.query.url) || '').trim();
  if (!url) { res.status(400).json({ error: 'url required' }); return; }
  res.status(200).json({ ok: true, url, ts: Date.now() });
}
