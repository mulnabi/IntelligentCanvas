# 로그인·회원가입 및 사용자 프로필 연동

구현·검증일: 2026-11-18

> 2026-11-20 후속 구현: [3단계 Canvas PNG 저장·복원](./Canvas_PNG_저장복원_연동검증.md)에서 인증 서비스의 로그아웃·계정 변경 전에 현재 그림 저장을 기다리도록 연결했다. 아래는 1단계 구현 기록이며, 인증·프로필 구조와 Firebase 초기화는 유지한다.

> 2026-11-19 후속 구현: 작품 목록이 UID별 IndexedDB 메타데이터로 연결되었다. 아래의 더미 목록·ID 없는 그림판 관련 설명은 1단계 당시 기록이다. 현재 작품 목록과 직접 확인 방법은 [2단계 작품 메타데이터 연동](./IndexedDB_작품메타데이터_연동검증.md)을 참고한다. 인증·프로필 서비스는 그대로 재사용한다.

설계 기준은 [2026-11-16 개정 DB 계획서](./IntelligentCanvas_DB_구축계획_개정본_2026-11-16.md)다. 이번 구현은 기존 인증 화면, Firebase Authentication, `users/{uid}` 프로필까지다. 작품 목록의 더미 데이터, Canvas·레이어, 작품 저장·편집 세션·수정 이력은 변경하지 않았다.

## 파일과 역할

| 파일                           | 역할                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `src/services/authService.js`  | 가입·로그인·로그아웃, 인증 상태 구독, 가입 후 프로필 저장 재시도, 오류 메시지 변환                |
| `src/services/userService.js`  | 본인 프로필 조회·최초 생성, 닉네임 수정                                                           |
| `src/hook/useAuth.js`          | 인증 복구 중 상태와 현재 Firebase User 관리, 구독 해제                                            |
| `src/config/firebase.js`       | 기존 초기화 재사용. 일반 앱은 로그인 유지, 별도 테스트 앱은 메모리 인증                           |
| `src/App.jsx`                  | 기존 폼에 콜백 전달, 성공 후 작품 목록으로 이동, `/singup` 호환 리다이렉트                        |
| `src/page/LoginPage.jsx`       | 로그인 요청·중복 제출 방지·기존 오류 영역 연결                                                    |
| `src/page/SignupPage.jsx`      | 입력값 전달, 닉네임 안내, 가입 오류·프로필 저장 재시도 처리                                       |
| `firestore.rules`              | UID 소유권과 프로필 필드 검증                                                                     |
| `src/dev/firebaseSmokeTest.js` | 기존 테스트 유지. 검사가 끝난 Firestore 연결을 일찍 종료해 일반 앱 연결과 함께 실행 가능하게 보완 |

CSS, 폼의 배치와 클래스는 유지했다. 기존 `username` 입력은 닉네임으로 사용하며 라벨과 안내 문구만 의미에 맞게 변경했다.

## 계정과 프로필의 구분

- Firebase Authentication: 이메일·비밀번호 인증과 UID 발급.
- Firestore: 아래 5개 필드만 `users/{uid}`에 저장.
- 닉네임 중복은 허용한다. 다른 UID가 같은 닉네임을 사용해도 별개의 사용자다.
- 닉네임 예약 컬렉션이나 닉네임 중복 검사를 만들지 않았다.
- 기본 입력 검증으로 닉네임의 앞뒤 공백을 제거하고 1~80자 범위를 사용한다.
- 이메일과 비밀번호는 프로필 문서에 저장하지 않는다.

| 필드            | 값                                                   |
| --------------- | ---------------------------------------------------- |
| `uid`           | 현재 인증 사용자의 Firebase UID. 문서 ID와 동일      |
| `nickname`      | 회원가입 폼의 `username` 값을 앞뒤 공백 제거 후 저장 |
| `createdAt`     | 최초 프로필 생성 시 서버 시각                        |
| `updatedAt`     | 생성 또는 닉네임 수정 시 서버 시각                   |
| `schemaVersion` | 정수 `1`                                             |

`ensureUserProfile()`은 Firestore 트랜잭션으로 프로필이 없는 경우에만 생성한다. 이미 있으면 기존 닉네임·생성일을 덮어쓰지 않는다. 닉네임 변경은 별도 `updateNickname()`으로 처리한다.

## 가입 후 프로필 저장이 실패하는 경우

Auth 계정 생성과 Firestore 저장은 하나의 트랜잭션이 아니다. 다음 두 결과를 구분한다.

1. **Auth 가입 실패:** 잘못된 이메일, 이미 가입된 이메일, 비밀번호 조건 등 가입 오류를 표시한다.
2. **Auth 가입 성공 후 프로필 저장 확인 실패:** 계정을 다시 만들거나 삭제하지 않는다. 현재 UID를 보존하고 기존 오류 영역에 부분 실패를 안내한다.

두 번째 경우에는 같은 화면의 가입 버튼이 **프로필 저장 다시 시도**로 바뀐다. 이메일은 고정되고 비밀번호 입력값은 지워지며 비밀번호 필드는 비활성화된다. 닉네임은 수정할 수 있다. 재시도는 현재 UID의 프로필만 저장하고 Auth 가입 API를 다시 호출하지 않는다.

로그아웃하거나 계정이 바뀐 상태에서는 이전 UID의 재시도를 차단한다. 원래 계정으로 다시 로그인한 후 재시도해야 한다.

화면을 새로고침해서 재시도 상태가 초기화된 경우에도, 같은 계정의 로그인은 유지된다. `/signup`에서 같은 이메일과 닉네임, 비밀번호를 다시 입력하면 이미 인증된 같은 UID를 재사용해 프로필 생성을 마친다. 기존 프로필이 있다면 덮어쓰지 않는다. 다른 브라우저에서 작업한다면 먼저 원래 이메일로 로그인한다.

## 로그인 상태와 실행 환경

일반 앱은 `browserLocalPersistence`를 사용한다. 동일 브라우저·동일 사이트 주소에서 새로고침하면 같은 UID가 복구된다. `useAuth()`는 인증 복구 중에 `loading: true`를 제공하고 인증 상태 변경을 구독한다.

기존 개발용 연결 테스트에서 생성하는 별도 이름의 Firebase 앱은 `inMemoryPersistence`를 유지하므로 일반 앱의 로그인 상태를 변경하지 않는다. 이는 Firebase 인증 설정이며 Dexie나 작품용 IndexedDB 저장 구현은 아니다.

개발 환경에서는 기존 `127.0.0.1:9099`, `127.0.0.1:8080` Emulator만 사용한다. 운영 환경이나 설정 오류에서는 인증이 중단되고 로그인 화면의 오류 영역에 안내한다. 기존 작품 목록과 그림판은 계속 렌더링할 수 있다. 이번 단계에서 운영 Firebase 연결을 활성화하지 않았다.

작품 목록·그림판에 새로운 인증 또는 편집 권한 제한을 추가하지 않았다. 이 화면들의 실제 작품별 편집 권한은 후속 단계의 범위다.

## 서비스 사용 예

화면 또는 다른 앱 모듈에서 사용하는 예다. 인증 정보와 설정 객체를 로그에 출력하지 않는다.

```javascript
import { loginUser, logoutUser } from "./services/authService";
import { getUserProfile, updateNickname } from "./services/userService";

const user = await loginUser({ email, password });
const uid = user.uid;
const profile = await getUserProfile(uid);
await updateNickname(uid, "표시할 닉네임");
await logoutUser();
```

가입은 `registerUser({ username, email, password })`, 부분 실패 재시도는 `retryProfileSave({ uid, nickname })`를 사용한다. 인증 구독 함수는 `subscribeToAuthState(onChange, onError)`이며 구독 해제 함수를 비동기로 반환한다. 화면에서는 직접 구독하기보다 `useAuth()`를 사용할 수 있다.

## 보안 규칙

| 작업                                         | 권한                                                      |
| -------------------------------------------- | --------------------------------------------------------- |
| 본인의 `users/{uid}` 단건 조회               | 허용                                                      |
| 본인의 프로필 생성                           | 정해진 5개 필드, UID 일치, 서버 시각, 스키마 검사 후 허용 |
| 본인의 프로필 수정                           | `nickname`, `updatedAt`만 변경 허용                       |
| UID·생성일·스키마 버전 변경                  | 차단                                                      |
| 비밀번호·이메일·임의 소유권 필드 추가        | 차단                                                      |
| 다른 UID 프로필 조회·생성·수정               | 차단                                                      |
| 비로그인 접근, 사용자 목록 조회, 프로필 삭제 | 차단                                                      |
| 작품·레이어·편집 세션·수정 이력              | 계속 차단                                                 |
| 기존 `connectionTests` 경로                  | 1단계의 제한된 테스트 규칙 유지                           |

부모 사용자 문서에 권한을 부여해도 하위 작품·세션 문서에 권한이 열리지 않도록 별도 경로만 허용한다. Emulator UI는 관리 도구이므로 UI에서 문서를 볼 수 있다는 것만으로 앱의 보안 규칙이 통과했다고 판단하지 않는다.

## 직접 브라우저에서 확인하기

### 1. 실행

Emulator가 이미 실행 중이면 유지한다. 꺼져 있을 때만 프로젝트 루트의 터미널에서 실행한다.

```powershell
firebase emulators:start --only auth,firestore --project ai-drawing-a9177
```

다른 터미널에서 Vite를 실행한다.

```powershell
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

브라우저에서 `http://127.0.0.1:5173/signup`을 연다. `localhost`와 `127.0.0.1`은 저장 공간이 다른 주소이므로 검증 중에는 같은 주소를 사용한다. 예전 `/singup`으로 접속해도 `/signup`으로 이동한다.

### 2. 첫 사용자 가입

예를 들어 다음 테스트 정보를 직접 입력한다. 실제 사용하는 이메일이나 비밀번호일 필요는 없다.

- 닉네임: `그림친구`
- 이메일: `student1@example.test`
- 비밀번호·확인: `CanvasTest123!`

가입하기를 누르면 처리 중 버튼이 비활성화되고, 성공하면 기존 작품 목록 `/`으로 이동한다. 이 목록은 이번에도 기존 더미 데이터 5개를 표시한다.

Emulator UI `http://127.0.0.1:4000`에서 다음을 확인한다.

1. Authentication 탭에 첫 번째 사용자가 있다.
2. 해당 사용자의 UID를 확인한다.
3. Firestore 탭의 `users` 컬렉션에 **동일 UID의 문서**가 있다.
4. 문서에는 위의 5개 필드만 있고 이메일·비밀번호는 없다.

### 3. 새로고침 후 UID 확인

개발자 도구 Console에서 다음을 실행한다. 환경설정값이나 토큰은 출력하지 않는다.

```javascript
(await import("/src/config/firebase.js")).auth.currentUser?.uid;
```

페이지를 새로고침한 뒤 인증 복구가 완료되면 같은 명령으로 UID를 확인한다. 처음부터 복구 완료를 기다리려면 다음을 실행한다.

```javascript
await (await import("/src/config/firebase.js")).auth.authStateReady();
(await import("/src/config/firebase.js")).auth.currentUser?.uid;
```

### 4. 로그아웃·로그인 오류 확인

새 로그아웃 버튼은 만들지 않았다. 제공한 서비스를 Console에서 호출한다.

```javascript
await (await import("/src/services/authService.js")).logoutUser();
```

`/login`을 열고 첫 이메일과 잘못된 비밀번호를 입력한다. 기존 오류 영역에 안내가 나타나고 목록으로 이동하지 않아야 한다. 올바른 비밀번호로 다시 제출하면 목록으로 이동한다.

### 5. 동일 닉네임의 두 번째 사용자

다시 로그아웃하고 `/signup`에서 닉네임은 `그림친구`로 유지하되 이메일은 `student2@example.test`로 가입한다. UID는 첫 사용자와 달라야 하고, Firestore에는 닉네임이 같은 두 UID의 프로필이 존재해야 한다.

이미 가입한 이메일을 로그아웃 상태에서 다시 가입하려 하면 이메일 중복 오류가 표시된다. 이는 닉네임 중복 제한과 별개다.

### 6. 프로필 실패 후 재시도 확인 (선택)

DevTools의 Network request blocking 기능으로 `*127.0.0.1:8080*`만 차단하고 새 테스트 이메일로 가입한다. Auth의 `9099`는 차단하지 않는다. 프로필 저장 실패가 표시되면 차단을 해제하고 **프로필 저장 다시 시도**를 누른다. Auth 계정 수가 늘어나지 않고 같은 UID 아래 프로필이 생성되는지 확인한다. 차단 해제 후에도 연결 복구가 되지 않으면 새로고침하고 위의 같은 계정 재시도 절차를 사용한다.

## 자동 검증 결과

2026-11-18, 로컬 Vite 앱과 Auth·Firestore Emulator를 Windows Edge의 별도 브라우저 환경에서 사용했다. 실제 화면을 조작하고 Firebase 웹 SDK로 검증했으며, 최종 통합 검사 **20개 항목이 통과**했다.

- 첫 사용자 가입·로그인·로그아웃, 잘못된 비밀번호 거부, 이미 가입한 이메일 오류.
- 두 번째 사용자의 동일 닉네임 가입과 두 UID의 프로필 필드·서버 시각 확인.
- 새로고침 후 UID 복구, 인증 상태 구독의 로그아웃 감지.
- 중복 제출 두 번에 Auth 가입 요청이 한 번만 발생하는지 확인.
- 본인 닉네임 수정 시 UID·생성일이 유지되는지 확인.
- 다른 UID 접근, 임의 UID 문서 생성, UID·생성일·스키마 변경, 비밀번호 필드 추가, 목록·삭제, 작품·세션·이력 쓰기 등 12개 금지 요청이 모두 `permission-denied`인지 검사.
- 비로그인 프로필 접근 차단.
- 테스트 브라우저에서 프로필 commit만 거부시켜 Auth 성공과 프로필 실패를 분리해 검증.
- 로그아웃 상태의 프로필 재시도 차단, 재로그인 후 동일 UID로 재시도 성공. 가입 API 재호출 없음.
- 재시도·반복 제출이 기존 닉네임·생성일을 덮어쓰지 않는지 확인.
- 기존 인증 페이지 이동, 더미 목록, Canvas 기본 드로잉, 레이어 패널 표시 확인.
- 기존 `runFirebaseSmokeTest()`의 14개 검사를 일반 앱 로그인 상태에서도 통과하며, 기본 앱 UID가 유지됨을 확인.
- 운영 빌드 미리보기에서 기존 목록 표시, 인증 기능의 Emulator 전용 안내, 운영 Firebase 요청 없음 확인.

최종 통합 검증용 사용자 3명의 계정과 프로필은 검증 후 정리했다. 기존 사용자 데이터를 전체 삭제하거나 보안 규칙에 삭제 권한을 추가하지 않았다. 자동 검사에서 외부 Firebase 요청과 처리되지 않은 브라우저 오류는 없었다.

`npm run build`는 성공했다. 번들 크기 500 kB 초과 안내가 있으며 빌드 실패는 아니다. `npm run lint`는 오류 없이 종료되며 기존 그림판 관련 경고 7개가 남아 있다. 이번 작업에서 해당 프론트엔드 코드는 수정하지 않았다.

운영 Firebase 배포·운영 인증·운영 프로필 저장은 이 검증 범위에 포함되지 않는다.

## 공식 참고 문서

- [Firebase 이메일·비밀번호 인증](https://firebase.google.com/docs/auth/web/password-auth)
- [Firebase 인증 지속성](https://firebase.google.com/docs/auth/web/auth-state-persistence)
- [Firestore 필드별 접근 제한](https://firebase.google.com/docs/firestore/security/rules-fields)
