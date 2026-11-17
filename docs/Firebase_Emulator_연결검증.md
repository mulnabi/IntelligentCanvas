# 1단계 Firebase Emulator 연결 검증

기준 문서: [최신 DB 구축 계획서](./IntelligentCanvas_DB_구축계획_개정본_2026-11-16.md)의 5장, 13장, 14장, 15장.

이번 단계는 React/Vite에서 기존 Firebase 프로젝트 `ai-drawing-a9177`의 **로컬 Auth·Firestore Emulator**에 연결하는 단계다. IndexedDB 저장, 작품별 편집 세션, 강제 복구, Storage, Functions는 구현하지 않는다.

## 파일별 역할

| 파일 | 역할 |
|---|---|
| `src/config/firebase.js` | 환경 검증, Firebase 초기화, Emulator 연결, 재사용할 `app`, `auth`, `db` 내보내기 |
| `src/dev/firebaseSmokeTest.js` | 별도 테스트 계정으로 인증·저장·서버 조회·권한 차단 검증 |
| `src/main.jsx` | 개발 환경에서만 콘솔 실행 함수 등록. 기존 React 화면은 유지 |
| `firestore.rules` | 테스트 경로의 소유자에게만 최소 권한 부여 |
| `.env.example` | 팀원이 참고할 변수 이름과 빈 설정 예시 |

## 준비

프로젝트 루트의 기존 `.env.local`에 다음 항목을 저장한다. 실제 값은 콘솔에 출력하거나 Git에 추가하지 않는다. `.gitignore`가 `.env.local`을 제외하며 `.env.example`만 공유한다.

- 필수: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`
- 이번 단계에서 선택: `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`
- 개발 안전 설정: `VITE_USE_FIREBASE_EMULATORS=true`
- 프로젝트 ID는 기존 `.firebaserc`와 같은 `ai-drawing-a9177`을 사용한다.

환경변수를 변경한 경우 Vite 개발 서버를 재시작한다. 브라우저에 전달되는 `VITE_` 변수에는 서비스 계정 비밀키나 AI API 비밀키를 넣지 않는다.

Emulator가 이미 실행 중이면 그대로 사용한다. 꺼져 있으면 프로젝트 루트의 별도 터미널에서 실행한다.

```powershell
firebase emulators:start --only auth,firestore --project ai-drawing-a9177
```

연결 주소:

- Authentication: `http://127.0.0.1:9099`
- Firestore: `127.0.0.1:8080`
- Emulator UI: `http://127.0.0.1:4000`

다른 터미널에서 프론트엔드를 실행한다.

```powershell
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

이번 검증은 Emulator와 같은 PC의 브라우저에서 실행한다. 휴대폰에서 `127.0.0.1`은 휴대폰 자신이므로, 실제 모바일 접속 설정은 이후 단계에서 다룬다.

## 명시적으로 테스트 실행

1. `http://127.0.0.1:5173`을 연다.
2. 개발자 도구의 Console에서 아래 코드를 직접 실행한다.

```javascript
const result = await window.runFirebaseSmokeTest()
result.success
```

앱 실행이나 새로고침만으로 계정·문서를 만들지 않는다. 최초 호출할 때만 테스트 모듈을 불러온다. 동시에 여러 번 호출해도 진행 중인 같은 테스트를 기다린다.

성공 시 `result.success`는 `true`이고, 항목별 콘솔 표에 `성공`이 표시된다. 실패 시 `false`이며 오류가 난 항목은 `실패`, 이후 실행하지 못한 항목은 `미검증`으로 구분한다. 초기 환경 검증이 실패한 경우에는 초기화 실패만 보고한다.

테스트는 실제 앱의 기본 Firebase Auth와 다른 이름의 인스턴스를 사용한다. 무작위 테스트 이메일·비밀번호로 두 사용자를 만들며, 앱의 기존 로그인 상태는 변경하지 않는다. 계정 정보와 토큰은 출력하지 않는다.

## 테스트가 하는 일

1. 별도 Firebase 인스턴스와 Emulator 연결을 준비한다.
2. Auth Emulator에서 소유자 테스트 계정을 생성하고, 로그아웃 후 같은 계정으로 다시 로그인한다.
3. `users/{uid}/connectionTests/{runId}`에 문서를 저장한다.
4. `getDocFromServer`로 캐시가 아닌 서버에서 문서를 조회한다.
5. `ownerUid`, `runId`, `environment`, `message`가 전송한 값과 정확히 일치하는지 검사한다. `createdAt`은 서버가 생성한 `Timestamp`인지 검사한다.
6. 다른 UID의 조회·생성·삭제가 모두 `permission-denied`로 거부되는지 검사한다.
7. 비로그인 상태의 조회·생성이 거부되는지 검사한다.
8. 추가 필드가 있는 잘못된 문서 생성과 작품·편집 세션·수정 이력 경로의 쓰기가 거부되는지 검사한다.
9. 원본 테스트 문서를 서버에서 다시 조회해 변조되지 않았는지 확인한다.
10. 이번 실행이 생성한 문서와 두 계정을 삭제하고 테스트 연결을 종료한다.

네트워크 오류나 시간 초과는 권한 차단 성공으로 간주하지 않는다. 각 네트워크 작업에는 10초 제한이 있으며, 장애 시 정리도 일부 실패할 수 있다. 이 경우 결과에 정리 실패를 표시한다. 기존 Emulator 전체 데이터나 다른 계정을 삭제하지 않는다.

## Emulator UI에 데이터를 남겨서 확인하기

기본 테스트는 검증 후 계정과 문서를 정리한다. 직접 UI에서 확인할 때만 다음 옵션을 사용한다.

```javascript
const result = await window.runFirebaseSmokeTest({ keepTestData: true })
result.documentPath
```

Emulator UI의 Firestore 탭에서 반환된 경로를 찾는다. Auth 탭에는 이번 실행의 두 테스트 계정이 남는다. 이 옵션은 문서·계정을 남기고 테스트 연결만 종료한다. 확인 후 UI에서 해당 테스트 데이터만 삭제할 수 있다.

## 연결과 보안 규칙

`src/config/firebase.js`는 다음 조건을 모두 만족할 때만 초기화한다.

- Vite 개발 환경 (`import.meta.env.DEV`)
- `VITE_USE_FIREBASE_EMULATORS`가 정확히 문자열 `true`
- 필수 Firebase 웹 설정 존재
- 기존 프로젝트 ID 일치

Auth와 Firestore는 첫 사용 전에 각각 고정된 로컬 주소로 연결한다. 설정 누락, 플래그 해제, 프로젝트 불일치, 운영 환경에서는 오류로 중단한다. Emulator 연결 실패 시 운영 서버로 전환하는 경로는 없다. **이번 단계는 운영 Firebase 연결을 제공하지 않는다.**

같은 앱 이름의 인스턴스는 재사용하며, Vite HMR에서도 연결 기록을 유지한다. 이 모듈 밖에서 이미 생성된 앱은 연결 대상을 확인할 수 없으므로 재사용하지 않고 새로고침을 안내한다. Auth는 메모리 세션을 사용하고, Firestore의 IndexedDB 영속 캐시는 활성화하지 않는다.

규칙에서 허용하는 범위:

| 경로·작업 | 권한 |
|---|---|
| 자신의 `users/{uid}/connectionTests/{testId}` 단건 조회·삭제 | 로그인 UID가 경로 UID와 같을 때 허용 |
| 같은 경로의 새 문서 생성 | 소유자 검사 + 정해진 필드·값·서버 시각 검사 |
| 테스트 문서 목록 조회·기존 문서 수정 | 차단 |
| 다른 UID·비로그인 접근 | 차단 |
| 사용자 프로필, 작품, 레이어, 편집 세션, 수정 이력 등 다른 모든 경로 | 차단 |

문서의 `environment: 'emulator'`는 데이터 형식 검증용 표시다. 보안 규칙 자체가 Emulator 환경을 식별하는 것은 아니다. 운영 접근 방지는 클라이언트의 개발 환경 검사·고정된 Emulator 연결과 운영 배포를 하지 않는 절차로 유지한다. 이 단계의 테스트 규칙을 운영 권한 정책으로 사용하지 않는다.

## 오류 확인

| 결과 | 확인할 부분 |
|---|---|
| `[Firebase 설정] 누락된 환경변수` | 메시지에 나온 변수의 이름·값 저장 여부 확인 후 Vite 재시작 |
| Emulator 설정 안내 | `VITE_USE_FIREBASE_EMULATORS=true` 확인 |
| 프로젝트 ID 불일치 | `.firebaserc`와 `.env.local`의 프로젝트 ID 일치 여부 |
| 연결 오류·시간 초과 | Emulator 터미널, 9099·8080 포트 확인 |
| 소유자 저장 단계의 권한 거부 | 현재 `firestore.rules`가 실행 중인 Emulator에 반영됐는지 확인. 필요하면 Emulator 재시작 |
| 차단되어야 할 요청이 허용됨 | 보안 규칙 오류. 테스트 실패로 처리하고 규칙 확인 |
| `window.runFirebaseSmokeTest`가 없음 | `npm run dev` 페이지인지 확인. 운영 빌드에는 테스트 함수가 없음 |

빌드 확인:

```powershell
npm run lint
npm run build
```

빌드는 로컬 `dist/`를 만들며 배포하지 않는다. 운영 빌드에서는 개발 전용 함수와 테스트 모듈을 제외한다.

## 실제 검증 기록 (2026-11-16)

- Windows Edge의 독립된 headless 브라우저에서 실제 Vite 앱과 Firebase 웹 SDK를 사용했다.
- 초기화, 테스트 계정 가입·재로그인, 문서 저장·서버 조회·필드 비교, 다른 UID 및 비로그인 접근 차단, 잘못된 형식 차단, 작품·세션·이력 쓰기 차단, 데이터 정리까지 14개 항목이 모두 성공했다.
- 앱 최초 진입 시 Auth·Firestore 요청은 0건이었다.
- 정상 검증 실행에서 브라우저의 외부 요청 시도를 감시했고, 운영 Firebase를 포함한 외부 서버 요청은 0건이었다.
- `.env.local`을 수정하지 않고 테스트 브라우저의 모듈 응답에 조건을 주입해 환경변수 누락, Emulator 플래그 해제, 운영 환경, 프로젝트 ID 불일치 시 초기화가 차단되는지 검증했다.
- 실제 Emulator 프로세스를 끄지 않고 테스트 브라우저의 네트워크 요청만 차단해 Auth·Firestore 연결 실패 시 성공으로 처리하거나 운영 서버로 전환하지 않는지 검사했다.
- Firestore 장애 시 SDK 내부 WebChannel이 `www.google.com/images/cleardot.gif`에 연결 진단용 GET을 시도하는 것도 관찰했다. 테스트 브라우저에서는 이 외부 요청을 차단했다. 이는 운영 Firestore로의 저장 전환이 아니며, 운영 Firebase API 요청은 없었다. SDK의 외부 진단 요청까지 전혀 발생하지 않는다고 보장하지는 않는다.
- `npm run build` 성공. Lint 오류 0개이며 기존 프론트엔드의 미사용 import·변수 경고 7개가 남아 있다.
- `npm run preview`로 운영 빌드도 브라우저에서 열어 기존 도구 UI 표시, 개발용 전역 함수 부재, 테스트 코드 제외, Firebase·외부 요청 0건을 확인했다.
- 초기화 함수를 다시 호출해도 같은 `app`, `auth`, `db` 객체가 반환되는 것을 확인했다.

이 기록은 로컬 개발 연결 검증 결과다. 운영 인증·저장·배포는 이번 단계에서 검증하거나 수행하지 않았다.

## 다음 단계

Dexie로 UID별 작품·레이어·PNG Blob·객체 JSON·동기화 대기열을 저장하고, 새로고침 후 같은 데이터가 복원되는지 검증한다. 현재 Canvas는 미구현이므로 먼저 샘플 데이터로 저장 모듈을 검증하고, 프론트엔드의 데이터 계약이 정해진 후 실제 드로잉 저장에 연결한다.

## 참고 문서

- [Firebase Auth Emulator 연결](https://firebase.google.com/docs/emulator-suite/connect_auth)
- [Firestore Emulator 연결](https://firebase.google.com/docs/emulator-suite/connect_firestore)
- [Firestore Security Rules 조건](https://firebase.google.com/docs/firestore/security/rules-conditions)
