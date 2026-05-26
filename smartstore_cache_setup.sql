-- ────────────────────────────────────────────────────────────────────
-- GPAGO 스마트스토어 정보 캐시 테이블 (네이버 429 차단 회피용)
-- ────────────────────────────────────────────────────────────────────
-- 동작: /api/smartstore-info 함수가 요청 들어오면 먼저 이 테이블에서
--       URL로 조회 → 캐시 있고 만료 안 됐으면 즉시 반환 (네이버 fetch 안 함)
--       캐시 없거나 만료면 네이버 fetch 후 결과를 여기에 저장 (TTL 7일)
--
-- 효과: 같은 상품을 N명이 봐도 네이버에는 1번만 요청 → 차단 위험 ↓↓↓
--       사용자 IP가 차단된 상태에서도 다른 사람/PC가 가져온 캐시는 사용 가능
--
-- 실행 방법:
--   1) Supabase 대시보드 (https://supabase.com) 로그인
--   2) GPAGO 프로젝트 선택 (gdsutxmceghvkemcfyuw)
--   3) 왼쪽 메뉴 "SQL Editor" 클릭
--   4) "New query" → 이 파일 전체 내용 복사·붙여넣기 → "Run" 클릭
--   5) 성공 메시지 확인 후 완료
-- ────────────────────────────────────────────────────────────────────

-- 1) 캐시 테이블 — URL을 기본키로 사용 (스마트스토어/브랜드스토어 상품 URL)
CREATE TABLE IF NOT EXISTS smartstore_info_cache (
  url        TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
);

-- 2) 만료 시간 인덱스 — 오래된 캐시 정리 시 사용
CREATE INDEX IF NOT EXISTS smartstore_info_cache_expires_idx
  ON smartstore_info_cache (expires_at);

-- 3) RLS 활성화 + anon key 로 읽기/쓰기 모두 허용
--    (캐시 데이터는 비밀 정보 아니므로 공개 허용)
ALTER TABLE smartstore_info_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "smartstore_cache_select" ON smartstore_info_cache;
CREATE POLICY "smartstore_cache_select"
  ON smartstore_info_cache FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "smartstore_cache_insert" ON smartstore_info_cache;
CREATE POLICY "smartstore_cache_insert"
  ON smartstore_info_cache FOR INSERT
  WITH CHECK (true);

DROP POLICY IF EXISTS "smartstore_cache_update" ON smartstore_info_cache;
CREATE POLICY "smartstore_cache_update"
  ON smartstore_info_cache FOR UPDATE
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "smartstore_cache_delete" ON smartstore_info_cache;
CREATE POLICY "smartstore_cache_delete"
  ON smartstore_info_cache FOR DELETE
  USING (true);

-- 4) (선택) 만료된 캐시 자동 정리 — 매일 새벽 실행되는 함수 예시
-- pg_cron 확장 필요. Supabase 대시보드에서 Database > Extensions > pg_cron 활성화 후 사용.
-- 미설정해도 동작에는 영향 없음 (캐시가 점점 쌓일 뿐).
-- DELETE FROM smartstore_info_cache WHERE expires_at < NOW() - INTERVAL '1 day';
