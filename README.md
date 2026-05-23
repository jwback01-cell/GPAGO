# GPAGO

네이버 쇼핑 API 기반 키워드 분석 · SEO 도구

## 로컬 미리보기

`index.html` 더블클릭 → 브라우저 자동 실행. UI 와 localStorage 기반 기능(특수 키워드/슬롯/도구)은 로컬에서도 동작합니다.

> ⚠️ 키워드 분석(네이버 쇼핑 API 호출)은 **CORS 제약**으로 로컬에서는 실패합니다. Vercel 배포 후 사용하세요.

## Vercel 배포 (5분)

### 1. GitHub 저장소 생성
```bash
cd c:/Users/jwbac/Desktop/gpago-site
git init
git add .
git commit -m "GPAGO 초기 커밋"
# GitHub 에 새 저장소 만든 뒤
git remote add origin https://github.com/USER/gpago-site.git
git push -u origin main
```

### 2. Vercel 연결
1. https://vercel.com/new 접속 → GitHub 저장소 import
2. Framework: Other / Build command 없음 (정적 사이트)
3. Deploy 클릭

### 3. 네이버 API 키 발급
1. https://developers.naver.com/apps/#/register 접속 → 로그인
2. **애플리케이션 등록**
   - 애플리케이션 이름: GPAGO
   - 사용 API: **검색** 선택
   - 비로그인 오픈 API 서비스 환경: **WEB**, URL 에 본인 Vercel 도메인 입력
3. 등록 후 **Client ID / Client Secret** 복사

### 4. 사이트에서 키 입력
- 배포된 사이트 → 키워드 분석 페이지 → 우측 상단 **API 설정** 클릭
- Client ID + Client Secret 입력 → 저장
- (또는 Vercel 환경변수 `NAVER_SHOP_CLIENT_ID`, `NAVER_SHOP_CLIENT_SECRET` 등록)

## 폴더 구조
```
gpago-site/
├── index.html              # 메인 페이지 (모든 UI + JS)
├── api/
│   └── naver-shop.js       # Vercel 서버리스 — 네이버 API CORS 프록시
├── vercel.json
├── package.json
└── README.md
```

## 페이지 (좌측 메뉴)

| 메뉴 | 기능 | API 필요 |
|------|------|----------|
| 대시보드 | (준비중) | - |
| 키워드 스크랩 | (준비중) | - |
| 반자동 프로그램 > **키워드 분석** | 네이버 쇼핑 상위 상품 분석 + 텀즈 빈도 + 카테고리·스토어 통계 | ✅ |
| 반자동 프로그램 > **특수 키워드** | 동의어 생성·저장 (60칸×3종) | - |
| 반자동 프로그램 > **기록 보관소** | 슬롯 5개 (각 200건) | - |
| 반자동 프로그램 > **키워드 도구** | 마누태그 자동추출 · 상품명 텀즈 마스터 | - |
| 스마트 순위추적 | (준비중) | - |
| 경쟁사 상품분석 | (준비중) | - |
| 키워드 성과분석 | (준비중) | - |
| AI 상품명 최적화 | (준비중) | - |
| SEO 마케팅 문의 | (준비중) | - |

## 데이터 저장

모든 사용자 데이터는 **브라우저 localStorage** 에만 저장됩니다 (서버 저장 X):
- `gpago_last_page` — 마지막 방문 페이지
- `gpago_analysis_history` — 키워드 분석 이력
- `gpago_synonyms_v1` — 동의어 저장소
- `gpago_slots_v1` — 슬롯 데이터
- `gpago_terms_recent` — 최근 텀즈 분석
- `gpago_naver_api_v1` — 네이버 API 키
