# IntelligentCanvas 11-A Firebase 실환경 연결 준비

기준 브랜치 `database` · 기준 커밋 `a3013f0` · 시작 시 작업 트리 깨끗함

[8단계 운영 환경](./8단계_운영환경_준비.md) · [9단계 통합 검증](./9단계_프론트_DB_통합검증.md) · [10단계 보안 사전점검](./10단계_보안_운영배포_사전점검.md)

11-A는 설정·격리·배포 절차의 로컬 검증이다. 실제 프로젝트와 계정, 버킷, DB, 결제 및 배포는 준비 상태를 조회하거나 변경하지 않았다. 아래 Console 작업과 클라우드 검증은 별도 승인 후 **독립 테스트 프로젝트**에서만 시작한다.

이 문서는 11-A의 기록이다. 테스트용 기본 Hosting을 포함한 최신 설정 및 명령은 [11-B-1 실환경 설정 가이드](./11-B-1단계_실제_Firebase_설정가이드.md)를 따른다.

## 1. 서비스별 준비 상태

| 항목 | 이미 코드에 있음 | 사용자가 준비할 값 또는 Console 작업 | 실제 환경에서만 확인할 내용 |
| --- | --- | --- | --- |
| 프로젝트·Web App | 웹·서버 프로젝트/리전/버킷 검증 및 오프라인 대조 도구. Emulator의 프로젝트 ID와 테스트 대상 중복 차단 | 독립 테스트 프로젝트 ID, 등록한 Web App SDK 설정 사본 | 프로젝트 소속과 실제 서비스 상태, 해당 웹 API 키의 실제 허용 범위 |
| Auth | 앱별 인증 지속성, UID 검사, 이메일/비밀번호, 무효 토큰 복구 | 이메일/비밀번호 공급자, 테스트 HTTPS 호스트의 Authorized Domains | 실제 가입·로그인·재접속·거부 및 토큰 검증 |
| Firestore | `(default)`, `firestore.production.rules`, `firestore.indexes.json` | 테스트 DB와 지역 선택, 운영 후보 Rules와 복합 인덱스 3개 적용 | 규칙의 실제 적용, 세 복합 인덱스 준비 완료 및 목록 쿼리 |
| Cloud Storage | `storage.production.rules`, 승인 버킷 일치 검사, Functions 경유 PNG 요청, 8 MiB 한도와 형식·해시 검증 | Blaze 승인, 실제 기본 버킷과 지역, 버킷 IAM 범위 확인 | 객체 생성·다운로드, 공개 접근 차단, 실제 비용·전송량 |
| Functions | Node.js 22·2세대 업무 API 15개, 운영 분리, 관리형 서비스 계정, 정확히 일치하는 CORS | 선택 리전, 전용 런타임 계정과 최소 IAM, 배포 권한 | 실제 HTTPS 호출, ADC 권한, API 오류 및 Cloud Logging |
| 웹 HTTPS | 웹 빌드가 승인 오리진·프로젝트·공개 설정을 요구함 | 테스트 전용 HTTPS 호스트, SPA 경로 재작성, 배포 채널 | TLS, 새로고침·직접 주소, OPTIONS 응답, 등록된 Auth 도메인 |
| 비용·알림 | PNG 크기 제한, 같은 저장 요청의 중복 확정 방지 | 테스트 예산·담당자·알림 기준, Functions 최대 인스턴스 및 사용량 검토 | Billing 보고서, 인덱스 읽기량, 저장·전송·실행 비용 |

**프론트엔드 호출 경로.** Auth와 Firestore는 같은 Firebase Web App의 SDK를 사용한다. Firestore에 대한 직접 접근은 프로필과 권한에 제한된 문서 조회에 쓰인다. 목록·권한·저장 준비와 확정은 Functions callable이고 PNG는 같은 프로젝트·리전의 `uploadArtworkPng`/`downloadArtworkPng`에 인증된 HTTPS 요청으로 보낸다. 브라우저의 직접 Storage 읽기·쓰기는 운영 후보 Rules로 차단된다. `checkServerEnvironment`와 `cleanupArtworkStaging`은 운영 Functions 등록에 포함되지 않는다.

Firestore Rules와 Storage Rules의 내용은 변경하지 않았다. 서버 작품 목록 인덱스 3개에는 `ownerUid`, `publication`, `state`와 각 정렬 필드 `updatedAt DESC`·`createdAt DESC`·`title ASC`가 필요하다. 테스트 프로젝트에서 인덱스 상태가 준비 완료인지 확인하고 각 정렬의 다음 페이지를 조회해야 한다.

## 2. 로컬 데이터와 자격 증명 보호

- **브라우저 주소 + 프로젝트 ID로 분리.** Emulator는 기존 `IntelligentCanvasLocal`, 기본 Auth 앱, 편집권 키를 그대로 사용한다. 클라우드 빌드는 `IntelligentCanvasLocal-cloud-<projectId>`, `intelligentcanvas-cloud-<projectId>` Auth 앱, 프로젝트별 편집권·장치·잠금 키를 사용한다. 같은 UID·작품 ID라도 다른 프로젝트의 작품·PNG·`syncQueue`·`recoveryDrafts`에는 접근하지 않는다. 명시적인 복구·이전 작업은 현재 단계의 범위 밖이다.
- 같은 프로젝트 안에서는 기존 UID 기반 키와 세션·버전 검사로 분리한다. 기존 DB 이름·버전과 레코드를 지우거나 복사하지 않는다. 설정이 불완전하면 Firebase 초기화가 실패하고 로컬 DB 자동 열기도 비활성화된다.
- 기본 빌드 및 `VITE_FIREBASE_ENABLE_PRODUCTION=false` 상태에서는 클라우드 연결이 잠긴다. 운영과 Emulator 설정을 혼합하거나 웹과 Functions의 버킷·리전·오리진이 다르면 검사가 실패한다. 초기 Auth의 웹 API 키는 Console에서 추출한 독립 SDK 설정과도 대조한다. 이 대조는 로컬 파일의 일치 검사이며 Firebase 프로젝트 존재·IAM 검증은 11-B에서 한다.
- 브라우저에는 코드에서 명시한 공개 Firebase 설정만 번들링한다. `VITE_*`에는 서비스 계정 JSON, 비밀번호, 개인 키, 서버 토큰을 넣지 않는다. Functions는 관리형 계정을 사용한다. 알려진 서비스 계정 파일명과 로컬 배포 설정은 Git에서 제외하고, 운영 Functions 패키징에서도 env 및 키 파일 패턴을 제외한다. 키를 만들거나 저장하는 작업은 필요하지 않다.
- 복구 초안은 브라우저·프로젝트 로컬 데이터다. Firestore 백업에 포함되지 않는다. 기존 Emulator 작품을 확인할 때 사용하던 개발 오리진과 브라우저 프로필을 보존한다.

## 3. 승인 후 Console 작업 순서

1. **프로젝트 만들기.** Firebase Console에서 **프로젝트 추가**를 선택한다. 구분하기 쉬운 테스트 이름을 정하고 **프로젝트 설정 → 일반**의 프로젝트 ID를 기록한다. 운영 프로젝트와 Emulator에 쓰는 ID는 사용하지 않는다. 이 프로젝트를 서비스별 화면 상단에서 매번 확인한다. [Firebase 프로젝트 이해](https://firebase.google.com/docs/projects/learn-more)
2. **Web App 등록.** 프로젝트 개요 또는 **프로젝트 설정 → 일반 → 내 앱**에서 웹 아이콘 `</>`을 선택해 테스트 Web App을 등록한다. SDK 설정의 `apiKey`, `authDomain`, `projectId`, `appId`, `messagingSenderId`와 실제 기본 버킷을 준비한 뒤의 `storageBucket`을 기록한다. 코드 검증은 기본 `<projectId>.firebaseapp.com` Auth 도메인을 사용한다. [Web App 등록 공식 문서](https://firebase.google.com/docs/web/setup)
3. **테스트 HTTPS 주소 결정.** 테스트 사이트 전용 주소와 사용자 접근 범위를 정한다. Firebase Hosting을 택하면 테스트 프로젝트에 연결된 HTTPS 호스트를 확인하고, 앱 경로는 `/index.html`로 재작성한다. 본 앱은 HTTP 경로·로컬 Emulator 오리진에서 운영 빌드를 사용하지 않는다. 예시의 웹 설정과 Functions CORS에는 동일한 오리진만 입력한다. [Firebase Hosting 시작하기](https://firebase.google.com/docs/hosting/quickstart) · [Functions CORS](https://firebase.google.com/docs/functions/http-events)
4. **Auth 활성화.** **Authentication → 시작하기 → Sign-in method**에서 이메일/비밀번호 공급자를 선택한다. **Authentication → Settings → Authorized domains**에 3에서 정한 **호스트명**을 확인하거나 추가한다. Authorized domains에는 스킴·경로를 붙이지 않고 CORS 값에는 `https://`를 포함한다. 실제 테스트 계정 가입은 배포 후 검증 단계에서 수행한다. [이메일/비밀번호 인증](https://firebase.google.com/docs/auth/web/password-auth)
5. **Firestore 생성.** **Firestore Database → 데이터베이스 만들기**에서 Standard 및 `(default)`를 선택하고 승인한 지역을 고른다. 초기 모드는 잠금 상태를 선택하고 이후 저장소의 운영 후보 규칙을 적용한다. 개별 공개 문서나 사용자 데이터를 미리 만들 필요는 없다. [Firestore 시작하기](https://firebase.google.com/docs/firestore/quickstart)
6. **결제·예산 확인 및 Storage 활성화.** Storage와 Functions가 필요한 실제 클라우드 검증을 승인한 다음 Blaze와 연결된 결제 계정을 확인한다. Google Cloud Billing에서 이 테스트 프로젝트에 예산과 수신자를 정한다. **Storage → 시작하기**에서 기본 버킷에 사용할 지역을 확인하고, 버킷 이름을 기록한다. **실제 Storage 활성화 시점은 첫 클라우드 PNG 검증을 준비할 때**다. Functions와 데이터 위치·버킷 간 전송 비용을 함께 검토한다. [Storage와 Blaze](https://firebase.google.com/docs/storage/web/start) · [예산 알림](https://cloud.google.com/billing/docs/how-to/budgets)
7. **런타임 계정 준비.** Google Cloud Console의 **IAM 및 관리자 → 서비스 계정**에서 테스트 프로젝트의 전용 계정을 선택하거나 만든다. 키를 다운로드하지 않고 계정 이메일만 기록한다. 실제 Firestore에 필요한 읽기·트랜잭션 쓰기와 승인 버킷의 객체 조회·생성 권한을 범위별로 확인한다. 과도한 관리자 권한이나 운영 프로젝트 공유 권한을 피한다. Functions 리전 및 배포 담당자의 계정 사용 권한도 확인한다. [Functions 런타임 SDK](https://firebase.google.com/docs/functions/config-env)
8. **운영 후보 배포 준비.** 최신 Web App SDK 설정에 실제 기본 버킷이 포함되는지 확인한다. 로컬 파일을 작성하고 아래 오프라인 검사에서 프로젝트 ID·버킷·리전·Auth 설정·CORS를 일치시킨다. 승인된 운영 후보 Rules와 인덱스만 사용하고 대상 프로젝트 ID를 모든 Firebase 명령에 명시한다. [인덱스 관리](https://firebase.google.com/docs/firestore/query-data/indexing)

## 4. 로컬 설정 예시와 11-B 명령 순서

예시의 `<...>`는 사용자가 확인한 값으로 바꾼다. 기존 `.env.local`은 보존하고 테스트는 `.env.firebase-test.local`에 따로 둔다.

```dotenv
VITE_FIREBASE_MODE=production
VITE_USE_FIREBASE_EMULATORS=false
VITE_FIREBASE_ENABLE_PRODUCTION=false
VITE_FIREBASE_PROJECT_ID=<테스트 프로젝트 ID>
VITE_FIREBASE_API_KEY=<Web App 공개 API 키>
VITE_FIREBASE_AUTH_DOMAIN=<Web App의 기본 authDomain>
VITE_FIREBASE_APP_ID=<Web App appId>
VITE_FIREBASE_MESSAGING_SENDER_ID=<Web App 프로젝트 번호>
VITE_FIREBASE_STORAGE_BUCKET=<Console에 표시된 기본 버킷 이름, gs:// 제외>
VITE_FIREBASE_FUNCTIONS_REGION=<선택한 리전>
VITE_FIREBASE_FUNCTIONS_BASE_URL=https://<리전>-<테스트 프로젝트 ID>.cloudfunctions.net
VITE_FIREBASE_APP_ORIGIN=https://<테스트 호스트>
```

`functions/.env.<테스트 프로젝트 ID>`에는 서버 값을 넣는다. `FIREBASE_CONFIG`, `K_SERVICE`, ADC 키 파일은 입력하지 않는다.

```dotenv
INTELLIGENTCANVAS_FUNCTIONS_MODE=production
INTELLIGENTCANVAS_PROJECT_ID=<테스트 프로젝트 ID>
INTELLIGENTCANVAS_STORAGE_BUCKET=<같은 기본 버킷 이름>
INTELLIGENTCANVAS_FUNCTIONS_REGION=<같은 리전>
INTELLIGENTCANVAS_WEB_ORIGIN=https://<같은 테스트 호스트>
INTELLIGENTCANVAS_SERVICE_ACCOUNT=<테스트 프로젝트의 런타임 서비스 계정 이메일>
```

**아래 명령 순서는 11-B 승인 이후에만 사용한다. 이번 작업에서는 실행하지 않았다.** 먼저 `.env.firebase-test.local`의 승인 값을 `true`로 바꾼다. Firebase 프로젝트 설정에서 받은 Web App 설정을 JSON으로 `.firebase/test-web-config.json`에 저장한다. 또는 승인 후 Firebase CLI의 `apps:sdkconfig WEB <appId> --project <테스트 ID> --json` 결과를 같은 파일에 저장할 수 있다. JSON은 SDK 설정 객체나 CLI 출력의 `result.sdkConfig` 형식을 받는다.

```powershell
$project = Read-Host 'Console에 표시된 독립 테스트 프로젝트 ID'
node scripts/check-firebase-test-config.mjs --project $project --web-config .firebase/test-web-config.json --prepare-config
if ($LASTEXITCODE -ne 0) { throw '대상 확인 실패. 배포를 중단합니다.' }
```

이 검사는 클라우드에 접속하지 않고, 검토한 템플릿에 **확인한 버킷 이름을 명시한** `firebase.firebase-test.local.json`을 생성한다. 생성한 구성의 Firestore·Storage·Functions 사전 배포 훅은 Firebase CLI가 제공하는 실제 프로젝트 ID가 검사에서 확인한 ID와 다르면 중단한다. 실제 Firebase CLI 배포에 이 훅이 호출되는지는 11-B에서 확인한다. 기존 배포 파일을 재사용하기 전에 같은 검사를 다시 실행한다.

```powershell
# 승인 뒤, 바로 위 검사를 통과한 동일한 터미널과 프로젝트에서만 실행
firebase.cmd deploy --project $project --config firebase.firebase-test.local.json --only "firestore:rules,firestore:indexes,storage,functions"
if ($LASTEXITCODE -ne 0) { throw '서버 배포 실패. 클라우드 앱 연결을 중단합니다.' }
npm.cmd run build -- --mode firebase-test
if ($LASTEXITCODE -ne 0) { throw '웹 빌드 실패.' }
```

서버 배포 후 Functions 15개와 Storage 대상, 인덱스 준비 상태를 확인한다. 그 뒤 `dist`를 별도 승인한 테스트 HTTPS 호스트에 배포한다. 이 명령 범위에는 Hosting 배포가 포함되지 않는다. 운영 기본값인 `firebase.json`/기존 프로젝트 별칭으로 대상을 추정하지 않는다. 릴리스 스테이징 전에는 `git status`에서 env와 키 파일 제외를 확인한다.

## 5. 11-B 실제 클라우드 시나리오

PC A, 독립 환경 B, 다른 UID C를 사용한다. 새 테스트 계정과 작품에 추적하기 쉬운 구분값을 붙인다. 검사 기록에는 시간, HTTP 상태, 함수명, 프로젝트·리전, 작품·요청 ID, `serverVersion`·`generation`을 필요한 범위에서 남기고 토큰·편집 증명·PNG 원문은 제외한다.

| 번호 | 실행 | 예상 결과 | 실패 시 확인 |
| ---: | --- | --- | --- |
| 1 | A에서 가입 | 테스트 Auth 사용자 1개 생성 | Auth 요청 응답 코드, 테스트 프로젝트, 이메일 공급자, Authorized Domains |
| 2 | 프로필 확인 | 같은 UID의 `users/{uid}` 생성 | Firestore Rules, `uid` 및 timestamp 필드, 가입 UI 재시도 |
| 3 | A에서 작품 생성 | 지정한 크기와 제목의 로컬 작품 1개 | 브라우저 IndexedDB 이름, UID, 저장 공간·트랜잭션 오류 |
| 4 | 다른 레이어에 그림 입력 | 각 레이어 PNG와 투명 알파가 로컬 저장 | Canvas 크기, blob 생성, PNG 디코딩, 로컬 저장 상태 |
| 5 | 서버 등록 후 PNG 저장 | Storage 쓰기와 확정 객체가 테스트 버킷에만 생김 | `uploadArtworkPng`, CORS, 런타임 IAM, 크기·MIME·해시 오류 |
| 6 | 버전 증가 및 같은 저장 요청 재시도 | 서버 버전 1회 증가, 같은 영수증 재사용 | `prepareArtworkSave`/`finalizeArtworkSave`, 요청 ID, 영수증과 인덱스 |
| 7 | B에서 같은 계정 로그인 | 같은 Auth 프로젝트·UID, B의 로컬 저장소는 독립 | 네트워크 SDK 대상과 로그인 실패 코드 |
| 8 | B에서 서버 목록과 각 정렬 페이지 조회 | 확정 작품이 나오고 20개 단위로 페이지 이동 | `listServerArtworks`, Firestore Indexes 상태, 커서·정렬 |
| 9 | B에서 이미지 다운로드 | A의 확정 레이어와 픽셀 일치 | `downloadArtworkPng`, 버킷 객체·manifest·버전·해시 |
| 10 | A와 B에서 동일 작품 열기 | A 편집, B 읽기 전용 | `getEditSessionStatus`, 현재 세션·세대, 쓰기 거부 응답 |
| 11 | A에서 편집 종료 | 저장 확인 뒤 편집권 반납 | 마지막 동기화 영수증과 `releaseEditSession` |
| 12 | B에서 편집권 획득 | 새 유효 세대, 이전 A 권한 거부 | `acquireEditSession`과 세대·증명 불일치 응답 |
| 13 | B를 오프라인으로 바꿔 수정 후 복귀 | 서버 요청은 복귀 이후 처리, 기존 권한으로 한 번 동기화 | DevTools 연결 상태, 로컬 대기열, 재시도와 최종 영수증 |
| 14 | A에서 강제 복구 후 B 재연결 | 더 높은 세대 획득, B 구세션으로 쓰기 거부 | `forceRecoverEditSession`, 구세션 finalize 거부 응답 |
| 15 | B에서 복구 초안과 서버 확정본 확인 | 오프라인 PNG 초안이 보존되고 새 서버 그림과 구분됨 | IndexedDB `recoveryDrafts`, 대기열 상태, 확정 버전·픽셀 |
| 16 | 편집 종료 뒤 서버 소프트 삭제 | 다른 기기 목록에서 사라지며 오래된 캐시로 재생성 불가 | `deleteServerArtwork`/`getDeletedServerArtworks`, 삭제 표식·버전 |
| 17 | 비로그인·다른 UID C·비허용 오리진으로 접근 | 읽기·쓰기 거부, 테스트 함수 미등록, 직접 Storage 쓰기 차단 | 적용 Rules, CORS preflight/응답, Auth UID 및 함수 목록 |
| 18 | 저장·다운로드·Functions 로그 대조 | 각각 테스트 프로젝트·버킷·리전의 정상 기록, 민감한 페이로드 없음 | Cloud Logging으로 함수명·오류 코드·요청 시간 확인, Billing과 egress 지표 대조 |

위 18건은 **11-A에서 미실행**이다. 실제 PC와 휴대폰에서 터치·펜, 화면 전환, 네트워크 전환도 11-B에 포함한다.

## 6. 비용과 잔여 보안 문제

- **Storage**는 저장한 버전별 PNG와 staging 용량, 객체 작업, 다운로드 및 리전 간 전송이 비용 항목이다. 확정본과 미확정 업로드의 보존 기간을 검토하고 삭제·정리 정책을 별도로 승인한다.
- **Firestore**는 문서·인덱스 읽기와 쓰기, 데이터·인덱스 저장, 보존·복구가 비용 항목이다. **Functions**는 호출, CPU·메모리·실행 시간, 네트워크, 빌드·아티팩트·로그 보존과 확장이 관련된다. **예산 알림은 청구나 사용량을 자동 차단하지 않는다.** 알림 수신자, 필요 시 최소/최대 인스턴스·쿼터, 알림 이후의 대응 주체를 정한다. [Firebase 요금표](https://firebase.google.com/pricing) · [Cloud Billing 예산](https://cloud.google.com/billing/docs/how-to/budgets)
- **npm 감사 재실행.** 프론트엔드 High 4개, Functions 0개다. 프론트의 `firebase`·Firestore·compat·`@grpc/grpc-js`는 같은 Node gRPC 의존 경로다. 현재 전체 브라우저 빌드의 모듈 목록을 확인했다. Firestore 웹 모듈이 포함되며 Node gRPC·Admin SDK·소스맵 도구 모듈은 포함되지 않는다. 서버와 Node 작업·SSR 경로가 달라지면 다시 평가한다. 의존성과 잠금 파일은 유지했다. [gRPC 인증 공지](https://github.com/advisories/GHSA-m9gg-hp2v-232j) · [gRPC 오류 처리 공지](https://github.com/advisories/GHSA-f596-whhp-79r4)

## 7. 변경 파일 및 검증 결과

| 파일 | 내용 |
| --- | --- |
| `src/config/firebaseRuntime.js`, `firebase.js` | 공개 환경변수 명시, 설정 실패 시 연결 차단, 클라우드 Auth 앱 이름 분리 |
| `src/db/localDb.js`, `src/services/editSessionService.js` | 프로젝트별 IndexedDB와 편집권 키. Emulator 스키마·키 보존 |
| `scripts/check-firebase-test-config.mjs`, `scripts/test-firebase-test-config.mjs` | 테스트 프로젝트 Web App·웹·서버 간 일치 점검 및 로컬 배포 대상 준비 |
| `scripts/test-firebase-production-browser.mjs` | 실제 Edge의 동일 HTTPS 오리진에서 클라우드 프로젝트 간 로컬 데이터 격리, 번들 환경값 범위 |
| `.gitignore`, `.env.example`, `firebase.production.example.json` | 별도 테스트 모드·배포 템플릿, 로컬 설정과 키 파일 제외 |

| 검사 | 결과 |
| --- | ---: |
| 기존 Edge·Emulator와 운영 보호 회귀 검사 | 139/139 |
| SDK 설정·프로젝트·버킷·오리진·리전 혼용 거부와 배포 훅 대상 검사 | 3/3 |
| Edge 프로덕션 빌드의 프로젝트 분리 및 번들 환경값 검사 | 1/1 |
| 합계 | **143/143 통과** |
| `npm.cmd run build` | 통과, 기존 대용량 청크 경고 1건 |
| `npm.cmd run lint`, `git diff --check` | 통과 |

- 신규 Edge 검사에서 같은 가짜 HTTPS 오리진의 두 클라우드 빌드를 차례로 로드했다. Auth·Firestore·Storage·Functions는 같은 프로젝트의 앱을 사용했고 Emulator 주소가 사용되지 않았다. 기존 대기열과 복구 초안, 편집권과 장치 키를 확인했으며 클라우드 네트워크 요청은 0건이었다. 빌드 산출물의 두 비밀값 검사용 문자열은 발견되지 않았다.
- 별도 기본 빌드를 Edge에서 열어 Firebase 요청 없이 로그인 폼이 설정 오류로 잠기는 것도 확인했다. 확인용 로컬 파일로 오프라인 검사 CLI를 실제 실행해 승인 버킷과 세 서비스의 대상 검사 훅이 생성됨을 확인했다. 사전 검사 Node 22.23.5 재실행도 3/3 통과했다.
- Firebase Console 작업, 실제 관리형 IAM, 라이브 규칙·인덱스와 배포 훅의 클라우드 작동, 18개 시나리오, 실제 휴대폰·PC 검증은 **미실행**이다. 활성 Emulator와 기존 IndexedDB 데이터는 초기화하지 않았다. 실제 요금제·서비스 변경, 배포, Git 커밋·푸시는 수행하지 않았다.

## 8. 11-B 시작 조건

- [ ] 독립 테스트 프로젝트 ID, 실제 Web App 및 Auth 공급자, 지정한 HTTPS 호스트 확인
- [ ] 예산·결제 승인, Firestore와 Storage 지역, 실제 기본 버킷 확인
- [ ] Functions 전용 관리형 계정과 배포 권한 확인
- [ ] 로컬 사전검사 통과와 승인된 Rules 및 인덱스 3개 재확인
- [ ] 서버·웹 배포 승인 및 이후 클라우드 18건의 테스트 계획과 로그 보존 방식 합의
