// Vercel 서버리스 함수 — 네이버 쇼핑 검색 프록시
// 2026 이관: 개발자센터 Search API(openapi.naver.com/v1/search/shop.json)가 종료(SE05)되어
//            NAVER API Hub(NCP)로 이관. 인증이 Client ID/Secret → NCP API Key 방식으로 바뀜.
//
// 우선순위:
//   1) NCP API Hub — 환경변수 NAVER_API_HUB_KEY_ID / NAVER_API_HUB_KEY (또는 헤더 x-ncp-key-id / x-ncp-key)
//   2) (레거시) 개발자센터 Client ID/Secret — 현재 SE05로 종료됨(폴백용으로만 유지)
//
// 호출: GET /api/naver-shop?query=마스크&display=100&start=1&sort=sim

const HUB_BASE = 'https://naverapihub.apigw.ntruss.com';
// API Hub 쇼핑검색 경로 — 뉴스가 /search/v1/news 로 확인됨 → 쇼핑은 /search/v1/shop (확장자 없음)
const HUB_SHOP_PATHS = [
  '/search/v1/shop',
  '/search/v1/shop.json',
  '/v1/search/shop.json',
  '/openapi/v1/search/shop.json',
];

async function tryHub(keyId, key, qs) {
  const headers = { 'X-NCP-APIGW-API-KEY-ID': keyId, 'X-NCP-APIGW-API-KEY': key };
  const attempts = [];
  for (const path of HUB_SHOP_PATHS) {
    const url = `${HUB_BASE}${path}?${qs}`;
    try {
      const r = await fetch(url, { headers });
      const text = await r.text();
      if (r.ok && text && (text.includes('"items"') || text.includes('"total"'))) {
        return { ok: true, text, path };
      }
      attempts.push({ path, status: r.status, snippet: text.slice(0, 120) });
    } catch (e) {
      attempts.push({ path, status: -1, snippet: String(e && e.message || e).slice(0, 120) });
    }
  }
  // 진단: 검증된 뉴스 경로로도 테스트 → 키/구독 문제인지 경로 문제인지 구분
  let newsProbe = null;
  try {
    const nr = await fetch(`${HUB_BASE}/search/v1/news?query=%ED%85%8C%EC%8A%A4%ED%8A%B8&display=1`, { headers });
    const nt = await nr.text();
    newsProbe = { status: nr.status, ok: nr.ok, snippet: nt.slice(0, 120) };
  } catch (e) { newsProbe = { status: -1, snippet: String(e && e.message || e).slice(0, 120) }; }
  return { ok: false, attempts, newsProbe, status: (attempts[0] && attempts[0].status) || 502 };
}

async function tryLegacy(clientId, clientSecret, qs) {
  const url = `https://openapi.naver.com/v1/search/shop.json?${qs}`;
  const r = await fetch(url, {
    headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret },
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-client-id, x-client-secret, x-ncp-key-id, x-ncp-key');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const q = req.query || {};
  const query = String(q.query || '').trim();
  if (!query) { res.status(400).json({ error: 'query 파라미터 필수' }); return; }
  const display = Math.max(1, Math.min(100, parseInt(q.display, 10) || 40));
  const start = Math.max(1, Math.min(1000, parseInt(q.start, 10) || 1));
  const sort = ['sim', 'date', 'asc', 'dsc'].includes(q.sort) ? q.sort : 'sim';
  const qs = `query=${encodeURIComponent(query)}&display=${display}&start=${start}&sort=${sort}`;

  // 레거시 개발자센터 키
  const clientId = req.headers['x-client-id'] || process.env.NAVER_SHOP_CLIENT_ID;
  const clientSecret = req.headers['x-client-secret'] || process.env.NAVER_SHOP_CLIENT_SECRET;
  // NCP API Hub 키 — 환경변수 우선, 없으면 전용 헤더, 그래도 없으면 프론트가 보낸 x-client-id/secret 를 NCP 키로 사용
  //  (프론트 '네이버 API 설정'의 Client ID=NCP KEY-ID, Client Secret=NCP KEY 로 입력하면 그대로 동작)
  const ncpKeyId = process.env.NAVER_API_HUB_KEY_ID || req.headers['x-ncp-key-id'] || clientId;
  const ncpKey   = process.env.NAVER_API_HUB_KEY    || req.headers['x-ncp-key']    || clientSecret;

  try {
    // 1) NCP API Hub 우선
    if (ncpKeyId && ncpKey) {
      const hub = await tryHub(ncpKeyId, ncpKey, qs);
      if (hub.ok) {
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.status(200).send(hub.text);
        return;
      }
      // NCP 키는 있는데 모든 경로 실패 → 진단 상세 반환
      res.status(hub.status && hub.status > 0 ? hub.status : 502).json({
        error: 'NAVER API Hub 쇼핑검색 실패',
        via: 'ncp',
        attempts: hub.attempts,        // 각 쇼핑 경로별 status
        newsProbe: hub.newsProbe,      // 검증된 뉴스 경로 결과 (200이면 키 정상 → 쇼핑 경로/구독 문제)
        hint: 'newsProbe.status가 200이면 키는 정상 — 쇼핑검색 경로 또는 쇼핑 API 구독을 확인. 401/403이면 키/구독 문제.',
      });
      return;
    }

    // 2) 레거시 (현재 종료됨 — 폴백)
    if (clientId && clientSecret) {
      const leg = await tryLegacy(clientId, clientSecret, qs);
      if (leg.ok) { res.setHeader('Cache-Control', 'public, max-age=60'); res.status(200).send(leg.text); return; }
      res.status(leg.status).json({
        error: '네이버 API 오류',
        via: 'legacy',
        detail: leg.text,
        hint: 'SE05(존재하지 않는 검색 api)면 개발자센터 검색 API가 종료된 것 — NAVER API Hub(NCP) 키가 필요합니다.',
      });
      return;
    }

    res.status(400).json({
      error: '네이버 API 키 없음',
      hint: 'NAVER API Hub(NCP) 키를 Vercel 환경변수 NAVER_API_HUB_KEY_ID / NAVER_API_HUB_KEY 에 설정하세요.',
    });
  } catch (err) {
    console.error('[naver-shop] 호출 실패:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
}

export const config = { api: { bodyParser: false } };
