// Vercel 서버리스 함수 — 네이버 자동완성(추천 검색어) CORS 프록시
// 호출: GET /api/naver-suggest?query=케이스
// 응답: { query: "케이스", suggestions: ["case", "캐이스", ...], source: "shopping"|"search" }
// 비고: 두 가지 네이버 자동완성 엔드포인트를 순차 시도 (별도 키 불필요)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function extractSuggestions(data) {
  // 응답 형태:
  //   { items: [ [ [name, ...], [name, ...] ], ... ] }   ← 일반 자동완성
  //   { items: [ [ [name, ...] ] ] }                    ← 단일 그룹
  const out = [];
  const seen = new Set();
  const push = (entry) => {
    const name = Array.isArray(entry) ? String(entry[0] || '').trim() : String(entry || '').trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };
  if (data && Array.isArray(data.items)) {
    for (const group of data.items) {
      if (Array.isArray(group)) for (const it of group) push(it);
    }
  }
  return out;
}

async function tryEndpoint(url, label) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      'Referer': 'https://search.naver.com/',
    },
  });
  if (!r.ok) throw new Error(`${label} ${r.status}`);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error(`${label} 파싱 실패`); }
  const suggestions = extractSuggestions(data);
  return { suggestions, raw: data };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const q = (req.query && req.query.query) ? String(req.query.query).trim() : '';
  if (!q) { res.status(400).json({ error: 'query 파라미터 필수' }); return; }

  // 시도 순서: 1) 쇼핑 자동완성 → 2) 통합검색 자동완성
  const candidates = [
    {
      label: 'shopping',
      url: `https://ac.shopping.naver.com/ac?${new URLSearchParams({
        q, q_enc: 'UTF-8', st: '1110', frm: 'nv',
        r_format: 'json', r_enc: 'UTF-8', r_lt: '1110', r_unicode: '0', r_escape: '1',
      }).toString()}`,
    },
    {
      label: 'search',
      url: `https://ac.search.naver.com/nx/ac?${new URLSearchParams({
        q, con: '1', frm: 'nv', ans: '2',
        r_format: 'json', r_enc: 'UTF-8', r_unicode: '0',
        t_koreng: '1', run: '2', rev: '4', q_enc: 'UTF-8', st: '100',
      }).toString()}`,
    },
  ];

  const errors = [];
  for (const c of candidates) {
    try {
      const { suggestions } = await tryEndpoint(c.url, c.label);
      res.setHeader('Cache-Control', 'public, max-age=600'); // 10분 캐시
      res.status(200).json({ query: q, suggestions, source: c.label });
      return;
    } catch (e) {
      errors.push(`${c.label}: ${e.message || e}`);
      continue;
    }
  }

  // 둘 다 실패
  res.status(502).json({
    error: '네이버 자동완성 호출 실패',
    detail: errors.join(' / '),
    hint: '네이버가 일시적으로 차단하거나 응답 포맷이 변경됐을 수 있습니다',
  });
}

export const config = {
  api: { bodyParser: false },
};
