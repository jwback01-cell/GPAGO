// 최소 테스트 함수 — Vercel 함수 배포 여부 확인용
export default function handler(req, res) {
  res.status(200).json({ ok: true, ts: Date.now() });
}
