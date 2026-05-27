// Vercel 서버리스 함수 — 네이버 쇼핑 자동완성(검색창 추천어) CORS 프록시
// 호출: GET /api/naver-suggest?query=케이스
// 응답: { query: "케이스", suggestions: ["케이스 추천", "케이스 비교", ...] }
// 비고: 네이버 내부 자동완성 엔드포인트를 사용 (별도 키 불필요)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const q = (req.query && req.query.query) ? String(req.query.query).trim() : '';
  if (!q) { res.status(400).json({ error: 'query 파라미터 필수' }); return; }

  const params = new URLSearchParams({
    q,
    q_enc: 'UTF-8',
    st: '1110',
    frm: 'nv',
    r_format: 'json',
    r_enc: 'UTF-8',
    r_lt: '1110',
    r_unicode: '0',
    r_escape: '1',
  });
  const url = `https://ac.shopping.naver.com/ac?${params.toString()}`;

  try {
    const r = await fetch(url, {
      headers: {
        // 네이버 자동완성은 일반 브라우저 UA 가 있어야 정상 응답
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Referer': 'https://search.shopping.naver.com/',
      },
    });
    const text = await r.text();
    if (!r.ok) {
      res.status(r.status).json({ error: '네이버 자동완성 오류', detail: text.slice(0, 500) });
      return;
    }
    let data;
    try { data = JSON.parse(text); } catch (_) {
      res.status(502).json({ error: '응답 파싱 실패', detail: text.slice(0, 300) });
      return;
    }
    // 응답 구조: { query: [...], items: [ [[name, type], [name, type], ...] ], ... }
    // items[0] 이 일반 자동완성 / items[1] 이 카테고리/매칭 (있을 때만)
    const out = [];
    const seen = new Set();
    const push = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const it of arr) {
        const name = Array.isArray(it) ? String(it[0] || '').trim() : String(it || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(name);
      }
    };
    if (Array.isArray(data.items)) {
      for (const group of data.items) push(group);
    }
    res.setHeader('Cache-Control', 'public, max-age=300'); // 5분 캐시 (자동완성은 자주 안 바뀜)
    res.status(200).json({ query: q, suggestions: out });
  } catch (err) {
    console.error('[naver-suggest] 호출 실패:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
}

export const config = {
  api: { bodyParser: false },
};
