# IntelligentCanvas 6단계 DB 최종 검증

2026-11-21 · `database` 브랜치 · Windows Edge와 로컬 Firebase Emulator

[개정 DB 계획서](./IntelligentCanvas_DB_구축계획_개정본_2026-11-16.md)와 [5단계 진행 기록](./5단계_작업진행상황.md)을 기준으로 1~5단계의 구현과 테스트를 대조했다. Auth 9099, Firestore 8080, Storage 9199, Functions 5001의 기존 프로세스를 사용했다. 브라우저 프로필과 테스트 계정을 분리했으며, 이번 실행에서 만든 데이터만 정리했다. Git 변경 사항과 기존 사용자 저장소를 보존했다.

## 설계 대비 구현 현황

| 항목 | 현재 상태 |
| --- | --- |
| 인증과 프로필 | 이메일 가입·로그인·로그아웃, UID 기반 프로필, 동일 닉네임 허용. 프로필 수정은 소유자 규칙으로 제한한다. |
| 작품과 레이어 | 로컬 작품 CRUD, 삭제 표식, 레이어별 PNG·설정 저장, 자동 저장과 복원. 3단계의 단일 PNG는 이전 원본 보존과 레이어 이관을 위해 남아 있다. |
| 서버 동기화 | 작품 등록, 레이어 원본 업로드·다운로드, `serverVersion`과 `generation` 검증, `requestId`와 `saveReceipts`로 재시도 중복 확정 방지. |
| 세션과 오프라인 | 작품별 단일 세션, 다른 기기·탭의 읽기 전용, 검증된 자격으로 오프라인 편집, 명시적 반납, 강제 복구와 이전 세션 차단. |
| 초안과 이력 | 무효화된 로컬 작업을 PNG까지 보존하는 초안, 별도 로컬 작품 복제, 최신 서버 확정본 읽기 전용 화면, 수정 이력 A 방식 최근 30건. |
| 제목과 삭제 | 로컬 제목 변경과 삭제 표식 지원. 서버 작품 제목은 유효한 세션의 그림판에서 바꾸고 서버 저장에 포함한다. 서버 등록 후의 삭제 API·서버 삭제 표식 전파는 미구현이며 현재 삭제 요청을 거부한다. |
| 계획서의 후속 범위 | 일반 서버 작품 복제, 서버 목록 페이지 처리, 완성·썸네일, 객체 저장과 AI 제안, 운영 배포·백업·복구 훈련은 후속 작업이다. 복구 초안은 브라우저 안에서 새 로컬 작품으로 복제할 수 있다. |

### 현재 데이터 계약

Dexie **v5** DB 이름은 `IntelligentCanvasLocal`이다.

| 테이블 | 키 또는 주요 색인 |
| --- | --- |
| `artworks` | `[uid+artworkId]`, 상태·수정일·생성일 색인 |
| `canvasContents` | `[uid+artworkId]`, 이전 단일 PNG |
| `layers` | `[uid+artworkId+layerId]`, `[uid+artworkId+sortOrder]` |
| `layerContents` | `[uid+artworkId+layerId]`, 레이어 원본 PNG Blob |
| `artworkSync` | `[uid+artworkId]`, 서버/로컬 확정 버전과 영수증 |
| `syncQueue` | `[uid+artworkId]`, 보조 색인 `uid`. 작품별 전송 스냅샷과 최신 로컬 버전을 비교해 순서대로 처리 |
| `recoveryDrafts` | `draftId`, 보조 색인 `[uid+artworkId]`. 이전 세션·세대별로 로컬 작품, 레이어·PNG, 대기 요청 ID 보존 |

로컬 작품·레이어 쓰기와 대기열 기록은 Dexie 트랜잭션에서 함께 처리한다. 서버는 UID·소유권·세션·세대·예상 버전을 확인한 후 Firestore의 작품, 레이어 참조, 영수증, 이력을 함께 확정한다. Storage 파일 저장은 Firestore 트랜잭션과 분리돼 있다. 수동 staging 정리 범위는 최소 24시간 지난 확정·폐기 영수증으로 판별 가능한 staging 파일이다. 원본 경로의 미참조 파일과 영수증 없는 파일을 위한 운영 정리 정책은 남아 있다.

## 보안 검증

- 비로그인 사용자의 Firestore·Storage·Functions 접근, 다른 UID의 프로필·작품·레이어·이력 조회와 수정, 다른 UID의 PNG 직접 접근과 Functions 다운로드를 거부했다.
- 작품 소유자 클라이언트의 `serverVersion`, 레이어, `editSession`, `revisions`, `saveReceipts` 직접 쓰기와 확정 Storage 객체 덮어쓰기도 거부했다. 이전 세대, 잘못된 세션 ID·토큰, 예상 버전 불일치 역시 서버 저장에서 거부했다.
- 브라우저 소스와 빌드에 Admin SDK 연결 또는 서비스 계정 비밀키를 포함한 경로를 발견하지 않았다. 로컬 `firebase-debug.log`, `firestore-debug.log` 및 빌드 산출물의 키·토큰 패턴 검사에서도 일치 항목이 없었다. 편집 클라이언트가 세션을 검증하는 데 쓰는 자체 증명은 해당 탭의 메모리와 `sessionStorage`에 저장된다. 서버는 토큰 해시를 세션 문서에 보관하며 다른 기기의 자격 증명을 반환하지 않는다. 운영 로그는 미검증이다.
- 운영 빌드의 로컬 미리보기에서 로그인 제출 차단과 Emulator 안내를 재현했다. 개발용 콘솔 스모크 함수가 없었고, Firebase 네트워크 요청도 발생하지 않았다.

## 발견된 문제와 수정

- **서버 목록의 오래된 제목.** B가 제목을 Firestore에 확정한 후 A가 서버 목록을 조회해도, 같은 작품 ID의 캐시 카드가 서버 카드 표시 정보를 덮어썼다. 신규 테스트에서 재현했다. `src/page/ArtworkList.jsx`에서 서버 목록을 열었을 때 서버 확정 제목·수정일을 사용하고 카드 한 개를 유지하도록 수정했다. A의 로컬 제목은 카드를 열기 전까지 보존되며, 열 때 기존 캐시 보호 규칙을 적용한다.
- **자동 검사 보강.** `scripts/test-artwork-sync.mjs`에 실제 가입·로그인 화면과 작품 생성, B의 제목/PNG 저장, 서버 확정 응답 유실 중 F5, A의 최신 이름 검색 및 한 카드 재다운로드, 8 MiB 경계 검사를 연결했다. `scripts/test-server-emulators.mjs`에는 프로필 수정 및 중복 닉네임과 소유권 필드 검사를 추가했다.
- 확장 검사 초기에는 비동기 DB 조건이 커밋 완료를 기다리지 않아 실패했다. 로컬 영수증이 확정될 때까지 조회하도록 수정했다. 이후 서버 목록의 오래된 제목을 재현하고 수정한 뒤 전체 관련 검사를 다시 통과했다.
- **서버 작품 삭제.** 로컬 작품은 tombstone으로 처리한다. 서버 등록 작품에서 삭제는 유효한 편집 세션에서도 차단되며 Firestore가 `active`로 남는 것을 검사했다. 데이터 손실을 피하기 위해 서버 삭제 API·규칙·실제 파일 정리를 추가하지 않았다. 이후 구현 시 소유권·세션·버전이 확인된 트랜잭션의 tombstone을 다른 기기에도 동기화하고, 참조·보존 정책에 따라 파일을 지우는 별도 작업이 필요하다.

## 자동 검증 결과

| 실제 실행 | 결과 | 주요 항목 |
| --- | --- | --- |
| 개발 콘솔 `runFirebaseSmokeTest()` | 14/14 | Firebase 초기화, Auth 가입·로그인, Firestore 일치, 직접 쓰기 규칙, 테스트 데이터 정리 |
| `test-server-emulators.mjs` | 14/14 | 서비스 4종, 사용자 프로필과 중복 닉네임, Firestore·Storage·Functions 접근 제어 |
| `test-artwork-metadata.mjs` | 24/24 | 인증·프로필, 다른 UID·로그아웃 차단, 로컬 CRUD, 저장 공간 예외 안내 |
| `test-canvas-persistence.mjs` | 33/33 | v1/v2 원본 마이그레이션, 레이어별 PNG·합성, 경쟁 입력, 트랜잭션 실패 후 재시도 |
| `test-edit-sessions.mjs` | 9/9 | 세션 동시 획득·두 탭·탭 종료, 오프라인 유지, 이전 권한과 무단 읽기 차단 |
| `test-artwork-sync.mjs` | 11/11 | 가입부터 A/B 다운로드까지, v3 데이터, 실제 PNG 비교, 서버 제목, 무중복 저장·복원, 업로드 오류와 크기 한도 |
| `test-offline-recovery.mjs` | 10/10 | v4 대기열, 세대 변경·유효하지 않은 요청, 초안 보존·복제, 읽기 전용 최신 화면, 이력과 staging |
| `npm.cmd run build` | 통과 | 500 kB 초과 번들 경고 |
| `npm.cmd run lint` | 통과 | 오류 0개, 기존 `Color.jsx`·`ToolPicker.jsx` 경고 2개 |

최종 자동 검사 **115/115 통과**. 빌드·lint와 로컬 빌드 미리보기 확인은 별도다.

- B의 서버 저장이 확정된 뒤 응답을 보류한 상태에서 F5를 눌렀다. 같은 `requestId`로 저장 영수증을 복구했고 Firestore 확정 버전은 한 번만 올라갔다. 저장한 레이어별 PNG와 합성 픽셀이 A의 재다운로드 및 B의 로컬 화면과 일치했다.
- 강제 복구 검사에서 A 로컬 v3와 Firestore 및 A의 별도 서버 화면 v5를 확인했다. Firestore가 참조한 Storage PNG·레이어 설정으로 합성한 전체 RGBA 해시가 A의 서버 화면과 일치했다. 초안의 레이어별 RGBA 해시는 A의 오프라인 작업과 일치했다. A의 대기열과 이전 PNG가 유지됐고, 재접속·새로고침 뒤에도 두 그림을 별도로 조회했다. 이력은 읽기 전용에서도 조회됐다.
- 레이어 PNG **8 MiB** 초과 경계는 테스트 픽스처로 검증했다. 서버는 한도를 넘은 메타데이터와 잘못된 PNG를 거부했고, 클라이언트는 초과를 표시하며 로컬 Blob과 동결된 대기열을 보존했다. 서버 버전과 확정 작품은 그대로였다.
- 로컬 보안 규칙과 로그 검사는 현재 Emulator 설정 기준이다. 실행 환경 Node.js는 24.20.0이고 Functions 배포 설정은 Node.js 22다. Node.js 22 및 운영 런타임 재검증은 남아 있다.

## 실제 기기 및 장애 조건의 남은 검증

- 두 프로필은 브라우저의 계정·쿠키·IndexedDB를 분리한다. 물리 기기 2대, Safari·Android Chrome의 터치나 펜, 실제 회선 전환과 백그라운드 복귀는 남아 있다.
- IndexedDB 용량 예외와 PNG 쓰기 실패는 테스트에서 주입했다. 실제 디스크 고갈, 전원 차단, 편집 후 1·3·5·10초 강제 종료별 복구율은 미검증이다. 정상적인 탭 종료의 세션 동작은 기존 테스트에서 검증했다.
- 최초 확정본이 없는 작품은 서버 목록에서 숨겨진다. 서버 등록 작품의 삭제 표식 전파와 실제 파일 정리, 서버 저장을 중단시킨 대용량 PNG를 로컬 원본을 보존하면서 교체·재처리하는 흐름은 남아 있다.

## 운영 Firebase 전환 전 준비

현재 빌드를 그대로 운영에 올리면 Firebase를 쓰는 인증·동기화 기능을 사용할 수 없다. `src/config/firebase.js`가 개발 Emulator 빌드만 허용하고, Functions의 `localFirestore.js`, 바이너리 파일 URL과 버킷, CORS에도 로컬 설정이 고정되어 있다. 운영 연결은 별도 변경과 검토가 필요하다.

1. **환경과 웹 설정** — 개발·검증용·운영 프로젝트를 분리한다. 웹 설정은 `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, 사용할 버킷 및 Functions 리전·URL을 명시한다. 개발용 `VITE_USE_FIREBASE_EMULATORS`와 운영 빌드의 구성을 분리한다. 운영은 HTTPS와 운영 서비스만 사용하고 잘못된 값에서는 연결을 중단한다. `/drawing/...`을 새로고침해도 앱으로 연결되도록 호스팅의 SPA 라우팅을 구성한다. Vite 빌드에 들어가는 `VITE_*` 값에는 서비스 계정 키·비밀값을 넣지 않는다. [Firebase 환경 분리](https://firebase.google.com/docs/projects/dev-workflows/general-security-guidelines)
2. **Authentication과 데이터 준비** — 운영 웹 앱 등록, 이메일/비밀번호 로그인 공급자와 필요한 인증 도메인 설정, 신규 가입과 유효 UID로 프로필 저장을 확인한다. Firestore 기본 DB를 준비하고 API·Storage의 리전, 지연 시간 및 비용을 함께 검토한다. 테스트 계정을 운영 사용자로 이전할 필요 여부는 별도로 결정한다. [이메일·비밀번호 인증](https://firebase.google.com/docs/auth/web/password-auth)
3. **Storage와 결제** — 실제 버킷 이름·리전은 운영 프로젝트 설정에서 확인한다. Storage 및 Functions에 필요한 Blaze 결제를 승인받고 저장량, 업로드·다운로드, Firestore 읽기·쓰기, Functions 실행과 네트워크 비용을 추정한다. 예산 알림과 서비스 사용량 경보를 설정한다. 일반 예산 알림은 자동 비용 한도를 제공하지 않는다. [Storage 준비](https://firebase.google.com/docs/storage/web/start) · [Functions 요금제](https://firebase.google.com/docs/functions/) · [Cloud Billing](https://docs.cloud.google.com/billing/docs/how-to/budgets)
4. **Functions** — 설정에 명시된 Node.js 22와 고정 의존성으로 검증 환경에서 테스트한다. 운영 런타임 서비스 계정에 필요한 권한만 부여하고 Admin SDK는 런타임 기본 자격 증명을 사용한다. 인증·소유권·세션·버전 검사를 그대로 유지한다. 운영 origin을 허용하는 CORS와 승인된 callable/바이너리 경로만 구성한다. 배포 대상 exports에서 `checkServerEnvironment`와 테스트 전용 정리 API를 제외하고, 운영 초기화와 로컬 Emulator 초기화를 별도 진입점으로 확인한다. 헤더·토큰·자격 증명은 로그 기록 대상에서 제외한다. [Functions 런타임](https://firebase.google.com/docs/functions/manage-functions) · [Admin SDK 인증](https://firebase.google.com/docs/admin/setup/)
5. **Rules와 인덱스** — 검증 프로젝트에서 실제 대상과 프로덕션용 규칙 파일을 확인한다. Firestore의 `connectionTests`와 Storage의 `_emulatorChecks` 권한을 운영 파일에서 제거한다. 작품·버전·세션·영수증·이력의 클라이언트 쓰기 차단, 사용자별 읽기, Storage 직접 접근 차단을 재검증한다. 승인 후 프로젝트와 버킷을 명시해 규칙·인덱스를 배포하는 절차를 준비한다. Admin SDK는 규칙을 우회하므로 공유 테스트에 함수의 인증·권한 검사도 포함한다. [Rules 배포](https://firebase.google.com/docs/rules/manage-deploy) · [Firestore Rules 검증](https://firebase.google.com/docs/firestore/security/test-rules-emulator)
6. **운영 복구** — Firestore 백업, Auth 계정 복구, 확정본과 백업이 참조하는 Storage 객체 보존을 함께 계획한다. 스테이징 복구 실습에서 백업 이후 생성·삭제된 작품, 권한 무효화, 오래된 탭의 DB 업그레이드와 파일 무결성을 확인한다. [Firestore 백업과 복원](https://firebase.google.com/docs/firestore/backups)

## 직접 확인하는 방법

1. 기존 로컬 Emulator가 실행 중이면 사용한다. 꺼져 있다면 프로젝트 루트에서 `firebase.cmd emulators:start --only "auth,firestore,storage,functions" --project ai-drawing-a9177`로 시작한다. 별도 터미널에서 `npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort`를 실행한다.
2. 서로 다른 브라우저 프로필 A와 B를 열어 같은 테스트 계정으로 로그인한다. A에서 작품과 레이어를 만들고 선을 그린 다음 **서버에 저장 → 편집 세션 받기 → 수정 시작**을 누른다. 서버 동기화 완료 후 목록에서 다시 열고 F5를 눌러 확인한다.
3. B에서 **서버 작품 보기**로 작품을 열어 동일한 레이어·그림과 읽기 전용 안내를 확인한다. A에서 **서버 저장 후 편집 종료**를 누르면 B에서 세션을 받을 수 있다.
4. 강제 복구 재검사는 A를 Network Offline 상태로 둔 뒤 선을 추가하고, B에서 명시적으로 강제 복구해 다른 선을 서버에 저장한다. A를 온라인으로 전환한 다음 **작품 목록 → 서버 작품 보기 → 같은 작품**에서 버전과 B의 선을 본다. **이 브라우저의 복구 초안**에서는 A가 따로 그린 선을 확인한다.
5. 실제 기기 검증은 승인된 HTTPS 검증 환경에서 시작한다. 두 기기에서 정상 반납과 강제 복구를 반복하고 실제 Wi-Fi/모바일 전환, Safari와 Android Chrome의 Web Locks 지원, 터치·펜·멀티터치, 화면 회전·백그라운드·재실행, 큰 캔버스의 메모리·저장 한도와 복원 시간을 측정한다. 테스트 데이터로만 시험한다.
