# IntelligentCanvas 11-B-1 실제 Firebase 설정 가이드

기준 브랜치 `database` · 기준 커밋 `a3013f0` · 시작할 때 11-A의 커밋 전 변경이 있던 상태

[10단계 보안 사전점검](./10단계_보안_운영배포_사전점검.md) · [11-A 환경 격리와 검증 기록](./11-A단계_Firebase_실환경_연결준비.md)

## 현재 준비 상태

로컬 Emulator의 Auth·Firestore·Storage·Functions와 실환경 보호 로직이 준비되어 있다. 11-B-1에서는 테스트 프로젝트의 **기본 Firebase Hosting 사이트**를 배포 구성에 추가했다. 설정을 생성하면 Firestore·Storage·Functions·Hosting의 사전 배포 훅이 모두 같은 프로젝트 ID를 확인한다. Hosting은 Vite의 `dist`를 제공하고 `/login`, `/signup`, `/drawing/<id>`처럼 파일이 없는 React 경로를 `/index.html`로 연결한다.

저장소에 실제 테스트 프로젝트의 `.env.firebase-test.local`, Web App SDK 설정 JSON, `functions/.env.<테스트 프로젝트 ID>`, 생성된 `firebase.firebase-test.local.json`이 없었다. 프로젝트, 사이트, 버킷, IAM, 결제 상태 및 실제 환경값의 일치 여부는 Console에서 확인해야 한다. 11-B-1에서는 해당 리소스에 접속하거나 변경하지 않았다.

## Console에서 직접 하는 작업

아래 작업 중 리소스 생성·활성화·결제·배포는 승인 후 테스트 프로젝트에서 진행한다. 작업 화면 위쪽의 **프로젝트 이름과 프로젝트 ID**를 매번 확인한다.

| 순서 | Console에서 클릭할 항목 | 코드에 준비된 부분과 아직 확인할 값 | 비용과 승인 |
| ---: | --- | --- | --- |
| 1 | Firebase Console에서 **프로젝트 추가**. 팀의 운영 프로젝트와 분리한 테스트 프로젝트를 만든다. | 별도 프로젝트를 요구하는 로컬 검사가 기존 Emulator ID를 거부한다. 실제 테스트 프로젝트 생성 여부는 미확인이다. | 신규 프로젝트 생성 승인. 프로젝트에 결제를 연결하는 절차는 아래 8단계에서 별도로 결정한다. |
| 2 | **톱니바퀴 → 프로젝트 설정 → 일반 → 프로젝트 ID**를 기록한다. | 이 ID를 모든 `--project`, Web App 및 Functions 파일에서 대조한다. 프로젝트 표시 이름과 ID는 서로 다를 수 있다. | 기존 값을 읽는 작업. |
| 3 | **프로젝트 설정 → 일반 → 내 앱**에서 웹 아이콘 `</>`을 선택해 Web App을 등록한다. | 앱 코드는 Firebase 웹 SDK를 이미 사용한다. 테스트 Web App의 실제 등록 상태는 미확인이다. | Web App 등록 승인. |
| 4 | **내 앱 → SDK 설정·구성 → Config**에서 `apiKey`, `authDomain`, `projectId`, `appId`, `messagingSenderId`를 기록한다. Storage 생성 뒤 최신 `storageBucket`을 다시 확인한다. | 오프라인 검사가 SDK 설정 사본을 웹 입력값과 필드별로 비교한다. | 기존 값을 읽는 작업. |
| 5 | **Authentication → 시작하기 → 로그인 방법 → 이메일/비밀번호**를 사용 설정한다. | 이메일/비밀번호 가입·로그인과 사용자 프로필 생성 코드가 있다. 실제 공급자가 켜졌는지는 미확인이다. | Auth 활성화 승인. 실제 가입은 11-B-2에서 별도 테스트 계정으로 진행한다. 사용량·상품에 따라 Auth 비용이 달라질 수 있다. |
| 6 | **Authentication → 설정 → Authorized domains**에서 사용할 Hosting 호스트명이 있는지 확인하고 필요하면 추가한다. | 웹과 Functions는 동일한 HTTPS 오리진을 요구한다. Authorized Domains에는 스킴 없이 호스트명만 넣는다. | 도메인 정책 변경 승인. |
| 7 | **Firestore Database → 데이터베이스 만들기**에서 Standard, `(default)`와 승인한 지역을 선택한다. 초기 규칙은 잠금 상태의 운영 모드를 선택한다. | 사용자 프로필과 작품 코드, 운영 후보 Rules 및 인덱스 파일이 있다. 실제 DB와 위치는 미확인이다. | DB 생성·지역 승인. 문서와 인덱스 작업, 저장, 백업·복구에 비용이 발생할 수 있다. |
| 8 | Firebase Console의 **사용량 및 결제**에서 테스트 프로젝트 요금제를 확인한다. | 실제 Storage 사용과 Cloud Functions 배포에는 Blaze가 필요하다. 로컬 검사는 현재 요금제로 계속 가능하다. | **Blaze 전환과 결제 계정 연결을 별도 승인**한다. 바로 아래에서 비용 알림을 준비한다. |
| 9 | Google Cloud Console의 **결제 → 예산 및 알림 → 예산 만들기**에서 테스트 프로젝트에 범위를 적용하고 알림 수신자를 선택한다. | 앱에서 결제 및 알림 설정을 변경하지 않는다. 실제 알림 수신 여부는 미확인이다. | 결제 계정 관리 권한과 알림 기준 승인. **예산 알림은 서비스나 지출을 자동으로 멈추지 않는다.** |
| 10 | **Storage → 시작하기**에서 지역을 확인한 다음 기본 버킷을 만든다. **Files** 화면과 Web App 설정에서 정확한 버킷 이름을 기록한다. | 승인한 기본 버킷 이름이 웹·서버·SDK 설정에서 일치하는지 검사한다. 기존 PNG 업로드는 레이어당 8 MiB와 형식 제한을 적용한다. | **첫 실환경 PNG 업로드·다운로드 검증을 준비할 때만** Blaze 승인 후 버킷을 만든다. 저장, 객체 작업, 다운로드, 지역 간 전송 비용이 발생할 수 있다. |
| 11 | **Functions**에서 승인된 지역의 사용 가능 여부를 확인한다. 지역은 Web App의 `functions` URL/리전과 서버 환경 설정에 동일하게 적용한다. | 업무용 2세대 Functions 15개와 Node.js 22 런타임이 준비되어 있다. 실제 리전 선택·배포는 남아 있다. Firestore·Storage와의 데이터 위치 및 전송 비용을 함께 본다. | 실행·메모리·네트워크·빌드·로그 비용. 실제 API 활성화와 배포를 승인받는다. |
| 12 | Google Cloud Console **IAM 및 관리자 → 서비스 계정**에서 테스트 프로젝트 전용 런타임 계정을 선택하거나 만든 뒤 이메일을 기록한다. | 관리형 계정 방식이 준비되어 있다. 서비스 계정 JSON 키는 만들 필요가 없다. 실제 IAM 권한은 미확인이다. | IAM 변경 승인. 런타임 계정과 배포 담당자의 권한을 별도로 검토한다. |
| 13 | **Hosting → 시작하기**에서 테스트 프로젝트 기본 사이트 ID와 HTTPS 주소를 확인한다. 기본 주소는 일반적으로 `https://<프로젝트 ID>.web.app` 및 `https://<프로젝트 ID>.firebaseapp.com`이다. 그중 확인한 주소 하나를 고른다. | 생성한 구성의 기본 사이트 ID, `public: dist`, SPA rewrite와 프로젝트 확인 훅이 준비됐다. 실제 HTTPS 주소 및 서비스 상태는 미확인이다. | Hosting 사이트 준비와 배포 승인. 무료 한도 및 저장·데이터 전송 요금은 Hosting 요금표에서 확인한다. |
| 14 | **Firestore Database → Rules, Indexes**에서 적용 상태를 확인한다. 승인 후 아래 명령으로 후보 규칙과 인덱스 3개를 적용한다. | `firestore.production.rules`와 `firestore.indexes.json`이 준비되어 있다. 수동 입력으로 파일과 Console 상태가 어긋나지 않도록 같은 파일을 적용한다. | Rules 변경과 인덱스 생성 승인. 인덱스 빌드 완료 때까지 목록 검증을 기다린다. 인덱스 저장·읽기는 비용 항목이다. |
| 15 | **Storage → Rules**에서 적용 상태를 확인한다. 승인 후 대상 버킷에 `storage.production.rules`를 적용한다. | 직접 브라우저·클라이언트 객체 읽기와 쓰기 거부가 준비되어 있다. 실제 적용 확인은 남아 있다. | 규칙 변경 배포 승인. 서비스 계정의 버킷 권한은 IAM에서 별도로 확인한다. |

Console 항목의 자세한 화면은 공식 문서를 참조한다. [Web App 등록](https://firebase.google.com/docs/web/setup) · [이메일/비밀번호 인증](https://firebase.google.com/docs/auth/web/password-auth) · [Firestore 만들기](https://firebase.google.com/docs/firestore/quickstart) · [Storage와 Blaze](https://firebase.google.com/docs/storage/web/start) · [Functions와 Blaze](https://firebase.google.com/docs/functions/get-started) · [Hosting 시작하기](https://firebase.google.com/docs/hosting/quickstart) · [예산 알림](https://cloud.google.com/billing/docs/how-to/budgets)

기본 Hosting 주소 두 개를 동시에 사용할 경우 두 오리진의 설정·로그인 지속성이 달라질 수 있다. 이번 테스트는 **한 주소만** 사용하고 `VITE_FIREBASE_APP_ORIGIN`과 Functions CORS에 같은 스킴과 호스트를 지정한다. 이메일 로그인 허용 목록에는 그 호스트명을 입력한다. Hosting의 인증서나 CDN은 실제 배포 뒤 확인한다. [Hosting 재작성](https://firebase.google.com/docs/hosting/full-config) · [Functions CORS](https://firebase.google.com/docs/functions/http-events)

## 테스트 환경변수와 배포 대상 확인

`.env.firebase-test.local`에 다음 값을 지정한다. `<...>`는 승인 후 Console에서 **실제로 확인한 값**으로 바꾼다. `.env.local`은 기존 Emulator 설정 파일이다.

```dotenv
VITE_FIREBASE_MODE=production
VITE_USE_FIREBASE_EMULATORS=false
VITE_FIREBASE_ENABLE_PRODUCTION=false
VITE_FIREBASE_PROJECT_ID=<테스트 프로젝트 ID>
VITE_FIREBASE_API_KEY=<Web App apiKey>
VITE_FIREBASE_AUTH_DOMAIN=<Web App 기본 authDomain>
VITE_FIREBASE_APP_ID=<Web App appId>
VITE_FIREBASE_MESSAGING_SENDER_ID=<Web App messagingSenderId>
VITE_FIREBASE_STORAGE_BUCKET=<실제 기본 버킷 이름, gs:// 제외>
VITE_FIREBASE_FUNCTIONS_REGION=<Functions 리전>
VITE_FIREBASE_FUNCTIONS_BASE_URL=https://<리전>-<테스트 프로젝트 ID>.cloudfunctions.net
VITE_FIREBASE_APP_ORIGIN=<확인한 기본 Hosting의 HTTPS 오리진, 끝 슬래시 제외>
```

`functions/.env.<테스트 프로젝트 ID>`에는 아래 값이 필요하다. Firebase 런타임이 설정할 `FIREBASE_CONFIG`, `K_SERVICE`, `GCLOUD_PROJECT`는 파일에 넣지 않는다.

```dotenv
INTELLIGENTCANVAS_FUNCTIONS_MODE=production
INTELLIGENTCANVAS_PROJECT_ID=<테스트 프로젝트 ID>
INTELLIGENTCANVAS_STORAGE_BUCKET=<같은 버킷 이름>
INTELLIGENTCANVAS_FUNCTIONS_REGION=<같은 리전>
INTELLIGENTCANVAS_WEB_ORIGIN=<같은 Hosting HTTPS 오리진>
INTELLIGENTCANVAS_SERVICE_ACCOUNT=<같은 프로젝트의 전용 런타임 서비스 계정 이메일>
```

Firebase Web App 설정과 서비스 계정 **이메일**은 공개 식별자다. 개인 키, 서비스 계정 JSON, 비밀번호, 인증·편집 토큰은 브라우저 환경변수·번들·Git·테스트 로그에 넣지 않는다. `.env*`의 개인 설정과 알려진 서비스 계정 파일명은 Git에서 제외되고, 운영 Functions 업로드도 env·키 파일 패턴을 제외한다. 파일을 스테이징하기 전에는 실제 포함 목록을 확인한다.

운영 설정 누락, 모드 혼합, 잘못된 ID·기본 버킷·리전·Functions URL·HTTPS 오리진은 초기 연결에서 차단된다. 웹 API 키는 사전검사에서 Console SDK 설정 사본과 값까지 대조한다. 같은 주소를 사용해도 클라우드 Firebase 프로젝트 ID별 Auth 앱과 IndexedDB가 분리되고, 로컬 UID 권한 및 `syncQueue`와 `recoveryDrafts`도 같은 경계를 따른다. 기존 Emulator 작품 자동 이전 경로는 없다.

## 11-B-2 승인 후 명령어와 의미

이 명령은 11-B-1에서 **실행하지 않았다**. 먼저 Console에서 프로젝트 ID·결제 상태·지역·버킷·기본 Hosting 사이트·계정을 확인한다. 그 뒤 웹 설정의 승인 플래그를 `true`로 바꾸고, Console SDK 설정 객체를 `.firebase/test-web-config.json`에 저장한다. 승인된 Cloud 조회로 CLI의 `apps:sdkconfig WEB <appId> --project <테스트 ID> --json`에서 받은 JSON도 사용할 수 있다.

```powershell
$project = Read-Host 'Console에서 확인한 독립 테스트 프로젝트 ID'
$config = 'firebase.firebase-test.local.json'

# 로컬 설정만 비교하고 동일 대상에 고정한 배포 설정을 준비한다.
node scripts/check-firebase-test-config.mjs --project $project --web-config .firebase/test-web-config.json --prepare-config
if ($LASTEXITCODE -ne 0) { throw '사전검사 실패. 배포 중단.' }

# 운영 후보 Firestore/Storage Rules와 목록 인덱스 3개를 적용한다.
firebase.cmd deploy --project $project --config $config --only "firestore:rules,firestore:indexes,storage"
if ($LASTEXITCODE -ne 0) { throw '규칙 또는 인덱스 적용 실패. 배포 중단.' }

# 같은 테스트 프로젝트와 리전의 업무용 Functions를 배포한다.
firebase.cmd deploy --project $project --config $config --only functions
if ($LASTEXITCODE -ne 0) { throw 'Functions 배포 실패. 배포 중단.' }
```

Console에서 **인덱스 3개 준비 완료**, **업무 함수 15개**, **같은 프로젝트·리전·버킷**, **테스트 함수 미등록**을 확인한 뒤 같은 터미널에서 웹을 빌드한다.

```powershell
# 웹 공개 설정과 대상이 바뀌지 않았는지 다시 확인한다.
node scripts/check-firebase-test-config.mjs --project $project --web-config .firebase/test-web-config.json --prepare-config
if ($LASTEXITCODE -ne 0) { throw '웹 배포 대상 확인 실패.' }
npm.cmd run build -- --mode firebase-test
if ($LASTEXITCODE -ne 0) { throw '테스트 웹 빌드 실패.' }
firebase.cmd deploy --project $project --config $config --only hosting
if ($LASTEXITCODE -ne 0) { throw 'Hosting 배포 실패.' }
```

생성한 구성에는 테스트 사이트와 버킷을 명시한다. Firestore·Storage·Functions·Hosting의 사전 배포 검사가 Firebase CLI에서 해석한 프로젝트 ID가 사전검사 결과와 다르면 중단한다. 해당 검사는 로컬에서 실행했고 실제 Firebase 배포에서의 호출은 미검증이다. 기본 `firebase.json`은 Emulator용이며, 배포 때 `--project`와 `--config`를 항상 명시한다. 승인받은 테스트 프로젝트에도 다른 팀의 기존 Firebase 리소스가 있는 경우 전체 배포 전에 영향을 먼저 확인한다. [Firebase CLI 대상·배포](https://firebase.google.com/docs/cli)

## 보안 규칙, API 및 권한 점검

- **Functions 및 인증**. 명시한 `production` 모드가 운영 진입점을 고른다. 같은 프로젝트의 런타임·기본 버킷·리전·서비스 계정과 정확한 HTTPS 오리진을 검증한다. Node.js 22의 로컬 Functions 규칙 검사에서 업무 함수 15개를 확인한다. `checkServerEnvironment`와 `cleanupArtworkStaging`는 운영 목록에 없다. 웹 callable과 PNG HTTP 함수 모두 인증 UID를 확인한다.
- **Firestore 서버 관리 문서**. 웹은 자신의 프로필을 제한적으로 작성할 수 있다. 자신의 작품·레이어 조회만 허용하고 서버 관리 문서의 직접 쓰기와 타 UID 접근은 거부한다. Functions가 편집 세션·`generation`·`serverVersion`·요청 ID 영수증을 검사한다. 삭제된 작품에는 신규 쓰기·재등록이 거부된다.
- **인덱스**. `artworks`의 `ownerUid`, `publication`, `state` 필드와 각각 `updatedAt DESC`, `createdAt DESC`, `title ASC` 정렬에 맞춰 3개가 정의되어 있다. Emulator는 실제 클라우드의 인덱스 구축 완료를 보장하지 않는다.
- **Storage 및 업로드**. `uploadArtworkPng`/`downloadArtworkPng` HTTPS 경로만 이용한다. 운영 후보 Rules는 브라우저의 파일 직접 읽기·쓰기를 모두 거부한다. 8 MiB, MIME, PNG 치수·해시·무결성과 신규 객체 조건을 적용한다. 서비스 계정의 버킷 IAM과 권한 검증 경계를 함께 본다.

| 승인 후 실행 | 배포 또는 실행에 필요한 권한 | 비용·주의점 |
| --- | --- | --- |
| 규칙·인덱스 적용 | 테스트 프로젝트의 Firebase Rules 관리·Firestore 인덱스 관리, 대상 Storage 버킷 확인 및 적용 권한. 권한 범위는 IAM 담당자에게 확인한다. | 조회·인덱스 저장·서비스 사용량 확인. 운영 후보 외의 규칙으로 초기 접근을 열어 두지 않는다. |
| Functions 배포 | 배포 담당자의 Functions 배포·트리거 정책 변경 권한, 전용 서비스 계정을 사용할 `iam.serviceAccounts.actAs` 권한, 필요한 관리형 빌드·런타임 서비스 에이전트. 조직 정책과 권한 거부를 먼저 확인한다. | Blaze 필요. 빌드, 아티팩트, 실행, 요청·로그, 객체 전송이 과금될 수 있다. |
| Functions 실행 | 전용 런타임 계정에 최소 Firestore 문서 읽기·쓰기와 해당 버킷의 객체 읽기·생성 권한을 검토한다. Admin SDK 권한에는 Firestore·Storage Rules가 적용되지 않는다. | 버킷 IAM을 프로젝트 전체 관리자 등으로 넓히지 않는다. 운영에 staging 정리용 일반 호출은 공개하지 않는다. |
| Hosting 배포 | 테스트 프로젝트의 Hosting 배포 권한과 기본 사이트 접근 권한. | 정적 파일 저장량과 전송 사용량. 기본 사이트의 HTTPS 호스트와 CORS·Authorized Domains를 재확인한다. |
| Billing 설정 | 결제 계정 연결 담당자의 권한 및 예산 알림 작성·조회 권한. | Functions·Storage 준비에 Blaze 필요. Firebase 요금표와 Google Cloud Billing 사용량을 대조한다. |

Storage 버킷의 **권한 → 액세스 권한 부여**에서 전용 런타임 계정을 대상으로 필요한 권한을 검토할 수 있다. 현재 업무 경로는 객체 읽기와 생성에 필요한 `storage.objects.get`과 `storage.objects.create`를 사용한다. Firestore는 같은 런타임 계정이 테스트 DB의 문서를 조회하고 저장 트랜잭션을 수행할 수 있어야 한다. 런타임 계정의 권한은 배포 담당자 권한과 별도로 테스트 프로젝트에 적용한다.

[Firebase 제품별 IAM](https://firebase.google.com/docs/projects/iam/roles-predefined-product) · [Functions IAM](https://cloud.google.com/functions/docs/reference/iam/roles) · [Firestore 서버 IAM](https://cloud.google.com/firestore/docs/security/iam) · [Storage IAM](https://cloud.google.com/storage/docs/access-control/iam-roles) · [Firebase 요금표](https://firebase.google.com/pricing)

## 11-B-2 실행 계획

| 순서 | 승인 후 실행할 작업 | 통과 기준 및 관찰 |
| ---: | --- | --- |
| 1 | 프로젝트 ID·Blaze·예상 사용량·리전 확인 | 실제 구분된 프로젝트와 알림 담당자를 기록한다. |
| 2 | 실제 버킷과 Functions 준비 확인 | Console 버킷 이름·지역이 Web App SDK 및 서버와 맞는다. |
| 3 | 런타임 서비스 계정과 배포 IAM 확인 | 해당 테스트 리소스에서만 필요한 권한이 있다. |
| 4 | Rules·인덱스 3개 적용 | 예상 파일과 실제 Rules가 일치하고 세 인덱스가 준비 완료다. |
| 5 | 업무 함수 배포 | 운영 진입점의 15개만 배포 대상이며 진단 함수는 제외된다. |
| 6 | HTTPS Hosting 테스트 배포 | 한 승인 오리진에서 `/login`과 작품 URL 직접 요청·새로고침이 유지된다. |
| 7 | 실제 테스트 Auth 가입·로그인 | 새 테스트 UID로 이메일 로그인과 프로필 생성이 성공한다. |
| 8 | 테스트 작품 Firestore 저장 | UID 하위에 작품 문서와 버전·영수증이 생성된다. |
| 9 | 실제 PNG 업로드·다운로드 | 승인 버킷에만 저장되며 레이어의 투명도·픽셀이 일치한다. |
| 10 | 두 기기에서 서버 목록 및 동기화 | 두 번째 기기의 로컬 저장소가 독립적이고 세 정렬 및 페이지에서 확정본을 본다. |
| 11 | 편집 세션·충돌 방지 | 한 기기가 편집하면 다른 기기가 읽기 전용이 된다. 반납 후 새 세션과 이전 세대·구버전 쓰기 거부를 확인한다. |
| 12 | 네트워크 중단·강제 복구 | 로컬 대기열 재동기화, 새 세대 발급, 구세션의 서버 저장 거부를 확인한다. |
| 13 | 복구 초안 보존 | 로컬 초안 PNG와 확정 서버 작품이 각자 유지된다. |
| 14 | 서버 소프트 삭제 | 다른 기기 목록에 반영되고 구버전 캐시에서 재등록할 수 없다. |
| 15 | 실제 클라우드 로그 확인 | 업로드·다운로드·저장 확정 요청과 비로그인·타 UID·허용되지 않은 오리진 거부를 확인한다. 토큰과 PNG 원문은 기록하지 않는다. |
| 16 | 비용·사용량 관찰 | 문서·인덱스 읽기, 개체 저장·다운로드, Functions 실행·빌드·로그, Hosting 전송량과 예산 알림을 확인한다. |
| 17 | 결과 기록 | 날짜·테스트 프로젝트·시험 계정 구분값·인덱스 상태·요청 ID·성공/실패·비용을 정리한다. 팀의 기존 계정과 운영 작품을 사용하지 않는다. |

단계별 예상 실패 로그는 [11-A의 18개 실환경 시나리오](./11-A단계_Firebase_실환경_연결준비.md#5-11-b-실제-클라우드-시나리오)에도 정리했다. 11-B-1에서는 위 클라우드 작업을 실행하지 않았다.

## 로컬 검증과 남은 작업

| 로컬 검사 | 결과 |
| --- | --- |
| 기존 인증·작품·레이어·편집권·동기화·삭제와 환경 보호 | 143/143 통과 |
| Hosting 사이트와 Rules·인덱스·Functions 배포 대상 고정 | 신규 1/1 통과 |
| 합계 | **144/144 통과, 실패 0** |
| Hosting Emulator + Edge | `/login`, `/signup`, `/drawing/<id>`의 직접 접속과 새로고침 통과. 기본 빌드의 외부 Firebase 요청 0건 |
| 사전검사 CLI의 전체 설정 생성 | 가짜 SDK 설정으로 정확한 Hosting 사이트·버킷 및 네 서비스의 대상 검사 훅 생성 확인 |
| Node.js 22.23.5 별도 검사 | Functions 운영 등록·CORS·기본 Rules 파일·인덱스·배포 설정 검사 8/8 통과 |
| `npm.cmd run build` · `npm.cmd run lint` · `git diff --check` | 통과, 기존 대용량 청크 경고 1건 |

실제 테스트 프로젝트 값 대조, HTTPS Hosting 배포, API와 IAM, 클라우드 Rules·인덱스·Storage, 결제 및 11-B-2 시나리오는 **미검증**이다. 별도의 Hosting Emulator는 임시 데모 프로젝트와 다른 포트로 열었다가 종료했다. 기존 Emulator, IndexedDB, PNG, 복구 초안, 대기열과 11-A의 작업 변경을 보존했다.

변경 파일은 `firebase.production.example.json`, `scripts/check-firebase-test-config.mjs`, `scripts/test-firebase-test-config.mjs`, 11-A 문서의 최신 가이드 링크, 이 가이드다. 앱 스키마·Emulator 설정·운영 후보 보안 규칙 본문을 유지했다.

11-B-2는 **테스트 프로젝트 ID·Web App 설정·기본 HTTPS 주소·버킷·리전·IAM·결제와 예산 확인**, **실제 배포에 대한 별도 승인**을 받은 뒤 시작한다.
