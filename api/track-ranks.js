// Vercel Cron — 키워드 순위 자동 추적 (브라우저 없이 서버에서 매일 실행)
// 스케줄: vercel.json crons "0 1 * * *" = 01:00 UTC = 10:00 KST
// 동작: Supabase gpago_kv 에서 (사용자별) 키워드 목록·상품·네이버 API키·순위기록을 읽어
//       openapi.naver.com 으로 순위를 조회하고 kw_rank_series/kw_rank_history 를 갱신해 다시 저장.
// 필요한 Vercel 환경변수:
//   SUPABASE_SERVICE_ROLE_KEY  (필수 — RLS 우회)
//   SUPABASE_URL               (선택 — 기본값 내장)
//   CRON_SECRET                (선택 — 설정 시 Authorization 검증)

import LZString from 'lz-string';

const SB_URL = process.env.SUPABASE_URL || 'https://gdsutxmceghvkemcfyuw.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const LZ_PREFIX = '__LZ__';

// 클라이언트와 동일 키
const K_MANAGE = 'kw_manage_list';
const K_EXTRA = 'kw_extra_products';
const K_API = 'kw_naver_api';
const K_SERIES = 'kw_rank_series';
const K_HIST = 'kw_rank_history';
const K_AUTO = 'kw_auto_tracking';
const READ_KEYS = [K_MANAGE, K_EXTRA, K_API, K_SERIES, K_HIST, K_AUTO];

function decomp(v) {
  if (v == null) return null;
  if (typeof v === 'string' && v.startsWith(LZ_PREFIX)) {
    try { return LZString.decompressFromUTF16(v.slice(LZ_PREFIX.length)); } catch (_) { return null; }
  }
  return v;
}
function parseKV(v, fallback) {
  try { const j = decomp(v); return j ? JSON.parse(j) : fallback; } catch (_) { return fallback; }
}
function stripTags(s) { return String(s || '').replace(/<[^>]+>/g, ''); }

// ── 상품 매칭 (클라이언트 _extractProductIds / _matchItem / _isPlusStoreItem 복제) ──
function extractProductIds(url) {
  if (!url) return [];
  const ids = new Set();
  let m;
  m = url.match(/\/products?\/(\d{6,})/i); if (m) ids.add(m[1]);
  m = url.match(/products?\/(\d{6,})/i); if (m) ids.add(m[1]);
  m = url.match(/[?&]nvMid=(\d{6,})/i); if (m) ids.add(m[1]);
  m = url.match(/[?&]productNo=(\d{6,})/i); if (m) ids.add(m[1]);
  m = url.match(/\/catalog\/(\d{6,})/i); if (m) ids.add(m[1]);
  m = url.match(/window-products\/[^/]+\/(\d{6,})/i); if (m) ids.add(m[1]);
  return [...ids];
}
function matchItem(item, productName, productIds) {
  if (productIds && productIds.length) {
    const link = (item.link || '') + ' ' + (item.productId || '') + ' ' + (item.productUrl || '');
    for (const pid of productIds) if (link.includes(pid)) return true;
    return false;
  }
  if (productName) {
    const title = stripTags(item.title || '');
    const norm = s => s.toLowerCase().replace(/[\s[\]()【】]+/g, '');
    const a = norm(title), b = norm(productName);
    if (!b) return false;
    if (b.length >= 8 && a.includes(b)) return true;
    return false;
  }
  return false;
}
function isPlusStoreItem(item) {
  const link = (item.link || '') + ' ' + (item.productUrl || '');
  return /smartstore\.naver\.com/i.test(link) || /brand\.naver\.com/i.test(link) || /shopping\.naver\.com\/window/i.test(link);
}

async function naverShop(query, start, display, id, secret) {
  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(query)}&display=${display}&start=${start}&sort=sim`;
  const r = await fetch(url, { headers: { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret } });
  if (!r.ok) throw new Error('naver ' + r.status + ' ' + (await r.text()).slice(0, 120));
  const j = await r.json();
  return (j.items || []).map(it => ({
    title: it.title || '', link: it.link || '', productId: it.productId || '',
    productType: it.productType || '', mallName: it.mallName || '',
  }));
}

// ── Supabase REST (service role — RLS 우회) ──
async function sbSelect() {
  const url = `${SB_URL}/rest/v1/gpago_kv?select=user_id,key,value&key=in.(${READ_KEYS.join(',')})`;
  const r = await fetch(url, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
  if (!r.ok) throw new Error('SB select ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}
async function sbUpsert(rows) {
  if (!rows.length) return;
  const r = await fetch(`${SB_URL}/rest/v1/gpago_kv`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error('SB upsert ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

export default async function handler(req, res) {
  // Cron 인증 (선택)
  if (process.env.CRON_SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) { res.status(401).json({ error: 'unauthorized' }); return; }
  }
  if (!SB_KEY) { res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY 환경변수가 없습니다' }); return; }

  const nowIso = new Date().toISOString();
  const kstDay = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST 날짜

  try {
    const rows = await sbSelect();
    // user_id 별로 그룹
    const byUser = {};
    for (const row of rows) {
      (byUser[row.user_id] = byUser[row.user_id] || {})[row.key] = row.value;
    }

    const summary = [];
    const upserts = [];

    for (const userId of Object.keys(byUser)) {
      const kv = byUser[userId];
      const manage = parseKV(kv[K_MANAGE], []);
      const extras = parseKV(kv[K_EXTRA], []);
      const api = parseKV(kv[K_API], {});
      const series = parseKV(kv[K_SERIES], {});
      const history = parseKV(kv[K_HIST], {});
      const auto = parseKV(kv[K_AUTO], {});

      if (!Array.isArray(manage) || !manage.length) continue;
      if (!api || !api.clientId || !api.clientSecret) { summary.push({ userId, skipped: 'no_api_key' }); continue; }
      if (auto && auto.lastRunDay === kstDay) { summary.push({ userId, skipped: 'already_today' }); continue; }

      const resolve = (productKey) => {
        if (!productKey) return null;
        const all = extras.map(p => ({ ...p, id: 'ex:' + p.id }));
        const direct = all.find(p => p.id === productKey);
        if (direct) return direct;
        if (/^ex:\d+$/.test(productKey)) { const i = parseInt(productKey.slice(3), 10); return all[i] || null; }
        return null;
      };

      let ok = 0, skipped = 0;
      for (const it of manage) {
        const product = resolve(it.productKey);
        if (!product) { skipped++; continue; }
        const ids = extractProductIds(product.url);
        const productKey = product.url || product.name;
        const keyword = it.keyword;
        const rankTypes = Array.isArray(it.rankTypes) && it.rankTypes.length ? it.rankTypes : ['price'];
        const range = 200;
        const cache = new Map();
        try {
          for (const rankType of rankTypes) {
            let found = null, virtual = 0;
            for (let start = 1; start <= range; start += 100) {
              const need = Math.min(100, range - start + 1);
              let items = cache.get(start);
              if (!items) { items = await naverShop(keyword, start, need, api.clientId, api.clientSecret); cache.set(start, items); }
              const filtered = rankType === 'plus' ? items.filter(isPlusStoreItem) : items;
              const idx = filtered.findIndex(x => matchItem(x, product.name, ids));
              if (idx >= 0) { found = rankType === 'plus' ? (virtual + idx + 1) : (start + idx); break; }
              if (rankType === 'plus') virtual += filtered.length;
              if (items.length < need) break;
            }
            const histKey = productKey + '||' + keyword + '||' + rankType;
            // 같은 KST 날짜에 이미 기록됐으면 중복 방지
            const arr = series[histKey] || (series[histKey] = []);
            const last = arr[arr.length - 1];
            const lastDay = last ? new Date(new Date(last.t).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10) : null;
            if (lastDay !== kstDay) arr.push({ t: nowIso, r: found });
            if (arr.length > 1000) series[histKey] = arr.slice(-1000);
            const h = history[histKey] || { prev: null, best: null, worst: null };
            const best = found == null ? h.best : (h.best == null ? found : Math.min(h.best, found));
            const worst = found == null ? h.worst : (h.worst == null ? found : Math.max(h.worst, found));
            history[histKey] = { prev: found == null ? h.prev : found, best, worst, last: nowIso };
          }
          ok++;
        } catch (e) {
          skipped++;
          // 실패해도 series 에 null 기록 (그날 시도 표시)
          rankTypes.forEach(rt => {
            const hk = productKey + '||' + keyword + '||' + rt;
            const arr = series[hk] || (series[hk] = []);
            const last = arr[arr.length - 1];
            const lastDay = last ? new Date(new Date(last.t).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10) : null;
            if (lastDay !== kstDay) arr.push({ t: nowIso, r: null });
          });
        }
      }

      auto.lastRun = nowIso;
      auto.lastRunDay = kstDay;
      upserts.push(
        { user_id: userId, key: K_SERIES, value: JSON.stringify(series), updated_at: nowIso },
        { user_id: userId, key: K_HIST, value: JSON.stringify(history), updated_at: nowIso },
        { user_id: userId, key: K_AUTO, value: JSON.stringify(auto), updated_at: nowIso },
      );
      summary.push({ userId, ok, skipped, keywords: manage.length });
    }

    await sbUpsert(upserts);
    res.status(200).json({ ok: true, day: kstDay, users: summary });
  } catch (e) {
    console.error('[track-ranks]', e);
    res.status(500).json({ error: e.message || String(e) });
  }
}

export const config = { api: { bodyParser: false } };
