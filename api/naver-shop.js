// Vercel 서버리스 함수 — 네이버 쇼핑 API CORS 프록시
// 호출: GET /api/naver-shop?query=마스크&display=40&sort=sim
// 헤더:  x-client-id : 네이버 Client ID
//        x-client-secret : 네이버 Client Secret
//        (또는 Vercel 환경변수 NAVER_SHOP_CLIENT_ID / NAVER_SHOP_CLIENT_SECRET 사용 가능)

export default async function handler(req, res) {
  // CORS 헤더 — 브라우저에서 직접 호출 가능
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-client-id, x-client-secret');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const q = req.query || {};
  const query = String(q.query || '').trim();
  if (!query) { res.status(400).json({ error: 'query 파라미터 필수' }); return; }
  const display = Math.max(1, Math.min(100, parseInt(q.display, 10) || 40));
  const start = Math.max(1, Math.min(1000, parseInt(q.start, 10) || 1));
  const sort = ['sim', 'date', 'asc', 'dsc'].includes(q.sort) ? q.sort : 'sim';

  const clientId = req.headers['x-client-id'] || process.env.NAVER_SHOP_CLIENT_ID;
  const clientSecret = req.headers['x-client-secret'] || process.env.NAVER_SHOP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(400).json({
      error: '네이버 API Client ID/Secret 누락',
      hint: '브라우저에서 헤더(x-client-id, x-client-secret) 로 전달하거나 Vercel 환경변수(NAVER_SHOP_CLIENT_ID, NAVER_SHOP_CLIENT_SECRET) 를 설정해 주세요',
    });
    return;
  }

  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(query)}&display=${display}&start=${start}&sort=${sort}`;
  try {
    const r = await fetch(url, {
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
      },
    });
    const text = await r.text();
    if (!r.ok) {
      res.status(r.status).json({ error: '네이버 API 오류', detail: text });
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=60'); // 1분 캐시
    res.status(200).send(text);
  } catch (err) {
    console.error('[naver-shop] 호출 실패:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
}

export const config = {
  api: { bodyParser: false },
};
