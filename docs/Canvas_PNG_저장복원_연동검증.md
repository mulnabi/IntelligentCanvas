# 3단계: 단일 Canvas PNG의 로컬 저장·복원

작성일: 2026-11-19 / 구현·최종 검증: 2026-11-20

> 완료: 실제 Edge + 로컬 Auth/Firestore Emulator + 격리된 IndexedDB에서 PNG 통합 검사 **27/27**, 기존 메타데이터 회귀 검사 **24/24**가 통과했다. 빌드 성공, lint 오류 0개·기존 경고 3개. 중단 지점과 재개 기록은 [작업 진행 상황](./3단계_작업진행상황.md)을 참고한다.

기준 문서는 [2026-11-16 개정 DB 구축 계획서](./IntelligentCanvas_DB_구축계획_개정본_2026-11-16.md)다. 기존 [Auth·프로필 연동](./Auth_프로필_연동검증.md)과 [2단계 작품 메타데이터 연동](./IndexedDB_작품메타데이터_연동검증.md)을 재사용한다.

이번 범위는 **현재 브라우저에서 작품 전체를 표현하는 단일 Canvas PNG 하나를 저장하고 복원하는 기능**이다. Firebase에는 작품 그림을 전송하지 않는다. 레이어별 그림, 다중 Canvas 합성, 편집 세션, 서버 수정 이력·복구 초안은 구현하지 않는다.

## 파일과 역할

1·2단계에서 미커밋 상태였던 파일을 포함하므로, 아래는 Git의 새 파일 여부가 아니라 **3단계에서 맡는 역할** 기준이다. 1·2단계 변경도 그대로 보존했다.

| 파일 | 역할 |
|---|---|
| `src/db/localDb.js` | 기존 DB 이름과 v1 메타데이터를 유지하면서 v2 콘텐츠 테이블 추가 |
| `src/repositories/artworkRepository.js` | 기존 인증·작품 소유권 검사를 콘텐츠 Repository에서도 재사용 |
| `src/repositories/canvasRepository.js` | PNG 조회·입력 검증, 콘텐츠와 작품 수정일의 원자적 저장 |
| `src/hook/useCanvasPersistence.js` | 복원 상태, 수정 추적, 자동 저장 순서·실패·재시도 관리 |
| `src/services/canvasImage.js` | 메모리 한도, PNG 추출·디코딩·원본 픽셀 복원, URL 정리 |
| `src/services/pendingCanvasChanges.js` | 현재 편집기의 미저장 작업과 인증 서비스 연결 |
| `src/components/DrawingSpace/DrawCanavs.jsx` | 실제 작품 크기 적용, 포인터 종료 통지, PNG 추출·픽셀 복원 인터페이스 |
| `src/page/DrawingSpace.jsx` | 기존 도구·레이어 UI와 저장 상태·작품 목록 이동 연결 |
| `src/page/ArtworkDrawingPage.jsx` | UID·작품 ID 경계와 그림판 진입 유지 |
| `src/App.jsx` | 앱 내부 이동을 저장 완료까지 기다릴 수 있도록 Router 연결 |
| `src/services/authService.js` | 앱 서비스의 로그아웃·계정 전환 전에 미저장 처리 연결 |
| `scripts/test-canvas-persistence.mjs` | 실제 Canvas 픽셀·IndexedDB·Emulator 통합 검사 |
| `scripts/test-artwork-metadata.mjs` | 기존 2단계 검사 중 DB 버전·Canvas 저장 기대값 갱신 |

기존 파일명은 **`DrawCanavs.jsx`**다. 별도 `DrawCanvas.jsx` 파일이나 새로운 React 프로젝트를 만들지 않는다. 기존 레이어 목록과 `useLayers`의 동작은 유지한다.

이번에 새로 추가한 모듈은 `canvasRepository.js`, `useCanvasPersistence.js`, `canvasImage.js`, `pendingCanvasChanges.js`다. 나머지는 기존 파일 확장이다. `useArtworks.js`는 기존 구독을 그대로 재사용했고, CSS·레이어 코드·Firebase 설정·Firestore 규칙은 3단계에서 변경하지 않았다.

## Dexie 버전과 테이블

- DB 이름: `IntelligentCanvasLocal` 유지
- 기존 Dexie 버전: `1`
- 새 Dexie 버전: `2`
- 기존 `artworks`: 기본키·인덱스·모든 레코드 유지
- 추가 `canvasContents`: 기본키 `[uid+artworkId]`

```javascript
localDb.version(1).stores({
  artworks: '[uid+artworkId], [uid+state+updatedAt], [uid+state+createdAt]',
})

localDb.version(2).stores({
  canvasContents: '[uid+artworkId]',
})
```

v2는 새 테이블만 추가한다. 기존 작품 데이터를 변환할 필요가 없어 레코드를 순회하는 `upgrade()`는 사용하지 않는다. DB 삭제, 테이블 비우기, 더미 작품 재삽입을 하지 않는다. HMR로 이전 v1 연결이 남아 있으면 연결만 교체하고 같은 이름의 IndexedDB를 연다.

최신 계획서의 최종 구조는 `layerContents`지만, 이번 요청은 단일 Canvas만 저장하므로 `canvasContents`로 분리했다. 실제 레이어 저장이 구현됐다는 오해와 미완성 레이어 모델의 선제 구현을 피하기 위한 범위 조정이다. `syncQueue`·`recoveryDrafts`는 아직 추가하지 않는다.

기존 v1 작품에는 PNG가 없으므로 **빈 Canvas로 정상 표시**한다. 단순히 기존 작품을 열었다는 이유로 빈 PNG를 자동 저장하거나 작품 수정일을 변경하지 않는다.

## PNG Blob 데이터 계약

| 필드 | 의미 |
|---|---|
| `uid` | 현재 인증된 Firebase UID |
| `artworkId` | 해당 UID가 소유한 활성 작품의 ID |
| `pngBlob` | MIME 유형이 `image/png`인 바이너리 `Blob` |
| `width` | PNG 원본 가로 픽셀 수 |
| `height` | PNG 원본 세로 픽셀 수 |
| `savedAt` | 저장 트랜잭션의 로컬 `Date.now()` 시각 |
| `schemaVersion` | 콘텐츠 레코드 구조 버전 `1` |

작품 하나에는 최신 PNG 하나만 둔다. 동일한 `[uid, artworkId]` 키로 성공한 새 저장이 이전 PNG를 대체한다. 과거 PNG 이력은 이번 범위에 없다. Blob을 Base64 문자열로 변환해 저장하지 않는다.

`savedAt`은 Firestore 서버 Timestamp가 아니다. PNG와 함께 갱신한 `artworks.updatedAt`은 같은 로컬 시각을 사용한다. DB 버전 `2`와 콘텐츠의 `schemaVersion: 1`은 서로 다른 버전이다.

Repository는 다음을 검사한다.

1. 전달한 UID와 기존 Firebase 기본 앱의 현재 로그인 UID가 일치하는지 확인한다.
2. 작품이 해당 UID 소유이며 `state='active'`인지 확인한다.
3. Blob 유형·크기, PNG 시그니처와 IHDR 헤더의 해상도를 확인한다.
4. PNG의 해상도와 `artworks.width/height`가 일치하는지 확인한다.
5. 조회·저장 도중 계정이 바뀌었다면 기존 UID의 작업을 차단한다.

현재 Repository의 PNG 파일 한도는 128 MiB다. 이는 전체 PNG를 다루는 단계의 입력 제한이며 기기의 인코딩·메모리 지원을 보장하지 않는다. 실제 디코딩은 Canvas 복원 단계에서 별도로 확인한다.

## 자동 저장 시점과 순서

```text
펜·지우개로 실제 수정
  → 포인터 입력 종료
  → 짧은 연속 입력 대기(250ms)
  → 현재 Canvas의 PNG Blob 추출
  → Blob·해상도 검증
  → IndexedDB 쓰기 트랜잭션 시작
  → canvasContents 저장 + artworks.updatedAt 갱신
  → 트랜잭션 성공 확인
  → 이 브라우저에 저장됨 표시
```

매 포인터 이동마다 PNG를 생성하지 않는다. 포인터가 Canvas 밖에서 끝나거나 취소되는 상황도 입력 종료 경로로 처리한다. 확대·축소, 도구 선택, React 리렌더, 최초 그림 복원만으로 자동 저장을 요청하지 않는다.

PNG 인코딩은 IndexedDB 쓰기 트랜잭션을 열기 **전에** 끝낸다. 이렇게 해야 이미지 인코딩을 기다리는 동안 IndexedDB 트랜잭션이 자동 종료되는 문제를 피할 수 있다.

저장 worker는 한 번에 하나만 실행한다. 저장을 시작한 수정 번호와 현재 수정 번호를 따로 추적하여, 저장 도중 새로 그린 그림을 이전 저장의 완료로 처리하지 않는다. 추가 수정이 있으면 다음 최신 그림을 이어서 저장한다. 일반 자동 저장 중에는 계속 그릴 수 있다.

성공한 트랜잭션만 작품의 `updatedAt`을 갱신한다. PNG 저장 또는 메타데이터 갱신 중 하나가 실패하면 둘 다 취소하며 이전에 저장된 PNG와 수정일을 보존한다.

저장에 실패하면 화면의 Canvas 픽셀은 유지하고 실패 안내와 재시도 방법을 표시한다. `toBlob()` 실패·빈 결과, PNG 검증 오류, 용량 부족, IndexedDB 오류를 저장 완료로 표시하지 않는다.

## 복원과 실제 크기 적용

작품을 열면 현재 UID와 작품 ID로 콘텐츠를 조회한다. PNG가 있으면 Object URL과 `Image`로 디코딩하고 원본 해상도를 확인한 뒤 Canvas에 그린다. 디코딩이 끝나기 전에는 새 펜 입력을 차단한다. URL은 완료·실패·중단 모두 `revokeObjectURL()`로 정리한다. 테스트의 픽셀 비교에 사용하는 `ImageBitmap`도 `close()`한다.

PNG가 없으면 메타데이터 크기의 빈 Canvas를 연다. PNG가 손상됐거나 해상도가 다르면 오류를 표시하며, 빈 그림으로 덮어써서 성공 처리하지 않는다. 오류 상태에서 기존 저장 데이터를 삭제하지 않는다.

Canvas 초기화·복원 기준은 **UID·작품 ID·실제 크기**다. 제목이나 `updatedAt`이 바뀌어 다시 렌더되어도 이미 그린 그림을 재복원하거나 지우지 않는다. 작품 A에서 B로 이동하면 새 작품의 Canvas를 준비하여 A 픽셀이 남지 않게 한다.

`canvas.width`와 `canvas.height`는 작품의 `width`·`height`를 사용한다. 화면 확대·축소는 CSS 표시 배율만 변경하며 PNG의 원본 해상도를 바꾸지 않는다. 포인터 위치는 현재 화면의 Canvas 경계와 원본 픽셀 비율로 환산한다.

배경색은 기존 작품 속성과 Canvas의 CSS 배경으로 유지한다. PNG에 배경색을 구워 넣지 않으므로 지우개로 지운 픽셀은 투명하게 보존된다.

작품 메타데이터의 각 변 허용 범위 1~8192는 유지하지만, 이번 단일 Canvas 렌더러에는 **총 16,777,216픽셀**의 안전 상한을 둔다. 예를 들어 8192×8192는 메타데이터로 존재할 수 있어도 이번 렌더러에서 편집하지 않고 안내한다. 4096×4096 RGBA 픽셀만 약 64 MiB이며, 인코딩·디코딩 사본과 브라우저 내부 메모리는 별도로 필요하다. 상한 이하에서도 기기 자원이 부족하면 실패할 수 있으므로 오류 처리가 필요하다.

## 작품 이동·로그아웃·종료의 보장 범위

### 앱 내부 이동

그림판의 작품 목록 링크나 브라우저 뒤로가기를 포함하는 앱 내부 이동에서 미저장 변경을 확인한다. 저장할 내용이 있으면 입력을 잠시 멈추고 저장 완료까지 이동을 기다린다. 저장 실패 시 현재 페이지와 픽셀을 유지하며 다시 저장하거나 현재 화면에 머물 수 있게 한다.

앱에서 제공하는 인증 서비스의 로그아웃·계정 전환도 기존 UID가 유효할 때 미저장 처리를 먼저 기다린다. 저장 실패를 무시하고 자동으로 로그아웃하지 않는다.

### 새로고침·브라우저 종료

미저장 변경이나 진행 중 저장이 있으면 `beforeunload`에서 브라우저의 이탈 경고를 요청한다. 브라우저가 표시하는 문구는 앱이 임의로 정할 수 없다. 사용자가 이탈을 승인하거나 브라우저·기기가 강제 종료되면 비동기 PNG 인코딩과 IndexedDB 저장 완료를 보장할 수 없다.

따라서 F5나 창 닫기 전에는 **저장 완료 표시를 확인하는 것이 보장 가능한 확인 방법**이다. 앱 서비스 밖에서 Firebase SDK를 직접 호출하거나 다른 탭에서 인증을 해제하는 경우도 사전 저장을 보장하지 못한다. 인증 해제 후 다른 UID로 쓰기를 이어가지는 않는다.

이번에는 복구 초안·강제 복구·다중 기기 편집 세션을 구현하지 않았으므로 이를 통해 미저장 데이터를 복구할 수 있다고 안내하지 않는다.

## 사용자 구분·작품 삭제

- 모든 콘텐츠 접근은 현재 UID와 작품 ID를 함께 사용한다.
- 다른 사용자의 작품 ID와 UID를 임의로 전달한 앱 요청은 거부한다.
- 로그아웃하면 화면의 작품 데이터는 숨기되, IndexedDB의 작품·PNG를 자동 삭제하지 않는다.
- 작품 소프트 삭제 시 기존 PNG는 보존한다. 삭제된 작품의 PNG 조회·저장은 앱에서 차단한다.
- **IndexedDB UID 검사는 앱 수준의 데이터 구분**이다. 개발자 도구로 로컬 DB에 접근하는 사람을 막는 암호화나 서버 보안 규칙이 아니다.

## 통합 검사 결과 — 2026-11-20 완료

자동 검사는 별도 브라우저 컨텍스트에서 수행하여 기존 사용자의 IndexedDB를 건드리지 않는다. 픽셀 복원은 Blob 존재 여부만으로 판단하지 않고 Canvas의 실제 RGBA 픽셀과 비교한다. 테스트에서 만든 Emulator 사용자·프로필만 정리한다.

| 검증 항목 | 현재 결과 |
|---|---|
| 새 작품 생성·빈 Canvas 시작 | 통과 |
| 펜 그리기·자동 저장 완료 | 통과, 실제 PNG Blob과 전체 RGBA 비교 |
| 목록 이동·같은 작품 재열기·픽셀 복원 | 통과 |
| F5 새로고침·기존 선 유지 | 통과, 저장 완료 이후 새로고침 |
| 기존 그림에 선 추가·재저장 | 통과 |
| 지우개 결과 저장·복원 | 통과, 지운 픽셀 포함 전체 RGBA 비교 |
| 작품 A/B 이미지 분리·전환 시 이전 픽셀 제거 | 통과, 1024×768 및 1920×1080 |
| 1024×768 실제 해상도·확대/축소 후 PNG 해상도 유지 | 통과, 원본 좌표의 픽셀까지 확인 |
| 저장 중 추가 수정의 최종 내용 보존 | 통과, 첫 `toBlob()` 완료 지연 중 추가 입력 |
| PNG 추출·저장·복원 실패 안내와 재시도 | 통과, null Blob·DB 오류·손상 PNG 주입 |
| UID별 PNG 구분·다른 UID의 접근 거부 | 통과, 직접 경로·UID 인자 위조·읽기/쓰기 모두 검사 |
| v1→v2 업그레이드·기존 메타데이터 보존 | 통과, 격리 컨텍스트의 v1 활성/삭제 작품 fixture 사용 |
| 저장 실패 시 PNG와 작품 수정일의 원자적 유지 | 통과, 두 번째 쓰기에 QuotaExceededError 주입 후 이전 값 비교 |
| 앱 내부 이동·뒤로가기·로그아웃 전 저장 | 통과, 저장 실패 시 화면 유지·재시도 포함 |
| 포인터가 Canvas 밖에서 종료·pointercancel | 통과 |
| 빈 곳 지우기·선택 도구·리렌더 시 불필요한 저장 방지 | 통과 |
| 손상 PNG·과대 Canvas 보호 | 통과, 기존 데이터 보존·입력 차단·할당 제한 |
| 소프트 삭제 PNG 보존·앱 접근 차단 | 통과 |
| 기존 로그인·회원가입·프로필 기능 | 통과, 동일 닉네임 별도 UID·잘못된 비밀번호·새로고침 포함 |
| 기존 작품 생성·검색·정렬·이름 수정·삭제/취소 | 통과, 기존 24개 회귀 검사 |
| 펜·지우개·색상 선택 | 통과 |
| 레이어 목록 조작 | 코드는 변경하지 않음. 레이어 조작 전체에 대한 별도 자동 검사는 미실행 |
| `npm.cmd run build` | 성공, JS 청크 약 1,007 kB로 Vite 크기 경고 1건 |
| `npm.cmd run lint` | 종료 코드 0, 오류 0개·기존 경고 3개 |

lint 경고는 `ToolPicker.jsx`의 미사용 `useRef`, `LayerPanel.jsx`의 미사용 `dragLeave`, `Color.jsx`의 effect 내부 state 갱신이다. 이번 저장 구현과 관계없는 기존 UI는 수정하지 않았다.

**미검증:** 실제 기기 메모리 고갈·디스크 용량 소진, 브라우저 강제 종료/전원 차단 중 내구성, 실제 모바일·펜 기기 및 Firefox/Safari. 오류 주입 통과를 실제 자원 고갈 시험 통과로 해석하지 않는다. 동일 작품을 여러 탭/기기에서 편집할 때 충돌 방지는 구현하지 않았다. 작품 카드의 PNG 썸네일도 이번 범위에 추가하지 않았다.

최종 실행 증거: [PNG 27개 검사 결과](./test-results/2026-11-20-canvas-persistence.json), [메타데이터 24개 검사 결과](./test-results/2026-11-20-artwork-metadata.json). 두 실행 모두 테스트 계정·프로필 정리가 성공했고 브라우저 미처리 예외·허용하지 않은 외부 요청은 0건이었다.

### 자동 검사 재실행

Emulator를 켠 뒤 Playwright가 사용 가능한 Node 환경에서 다음 명령을 실행한다. 각 스크립트가 자체 Vite 서버(5188/5187)와 격리된 Edge를 열고 종료한다.

```powershell
node scripts/test-canvas-persistence.mjs
node scripts/test-artwork-metadata.mjs
npm.cmd run build
npm.cmd run lint
```

현재 Codex 환경의 Playwright를 재사용하려면 실행 전에 다음 환경변수를 설정한다. 경로가 다른 개발 환경에서는 설치된 `playwright/index.mjs`의 경로로 바꾼다. 프로젝트 의존성은 이번에 변경하지 않았다.

```powershell
$env:PLAYWRIGHT_MODULE_PATH = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright\index.mjs'
```

초기 `auth/network-request-failed`는 테스트 브라우저의 loopback 접근 권한 거부였다. [Playwright의 출처별 권한 API](https://playwright.dev/docs/api/class-browsercontext#browser-context-grant-permissions)로 테스트 출처에만 `local-network-access`를 허용했다. 사용자 브라우저 설정이나 앱의 Firebase 연결 대상은 바꾸지 않았다.

## 다음 레이어 저장 단계에 필요한 작업

현재 PNG는 작품 전체의 단일 이미지다. 레이어 선택에 따라 그릴 대상이 바뀌거나 레이어 숨김·불투명도가 실제 그림에 반영된 상태가 아니다.

다음 단계에서는 프론트엔드와 다음 계약을 먼저 맞춰야 한다.

1. 레이어 ID마다 독립적인 픽셀 원본을 유지하는 구조.
2. 활성 레이어 선택을 실제 그리기 대상과 연결하는 방식.
3. 순서·숨김·불투명도를 적용하는 합성 렌더링.
4. 레이어별 PNG와 메타데이터를 같은 로컬 저장 단위로 확정하는 방법.
5. 현재 단일 PNG 작품을 레이어 구조로 옮길 때 기존 그림을 보존하는 마이그레이션.

서버 편집 권한·Storage 업로드·수정 이력·강제 복구는 그와 별개의 후속 단계다. 로컬 PNG 저장만으로 다른 기기와 동기화하거나 동시 편집을 안전하게 할 수는 없다.

## 직접 테스트: 실행부터 그림 복원까지

### 1. Emulator 실행

이미 실행 중이면 그대로 둔다. 꺼져 있다면 프로젝트 루트의 터미널에서 실행한다.

```powershell
firebase.cmd emulators:start --only auth,firestore --project ai-drawing-a9177
```

### 2. React 실행

다른 터미널에서 실행한다.

```powershell
npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

확인하는 동안 동일 브라우저·동일 주소를 사용한다. `localhost`와 `127.0.0.1`, 다른 포트는 서로 다른 IndexedDB 저장소다.

### 3. 로그인

`http://127.0.0.1:5173/login`에서 기존 계정으로 로그인한다. 계정이 없다면 `/signup`에서 먼저 가입한다. Emulator 계정을 삭제한 뒤 같은 이메일로 다시 만들면 UID가 달라져 이전 작품을 볼 수 없을 수 있으므로 계정을 유지한다.

### 4. 작품 생성

**+ 새 작품**에서 제목 `PNG 저장 연습`, 가로 `1024`, 세로 `768`로 생성한다. 만들어진 카드를 눌러 그림판을 연다. PNG가 아직 없으므로 빈 그림으로 시작하는 것이 정상이다.

### 5. 그림 그리기

펜으로 구분하기 쉬운 선 두세 개를 그린다. 필요하면 색상을 바꿔 다른 색 선도 추가한다. 마우스 또는 펜을 놓으면 자동 저장이 시작된다.

### 6. 저장 확인

그림판의 작은 저장 안내가 **이 브라우저에 저장됨**으로 바뀌는지 확인한다. 실패 안내가 나오면 화면을 떠나지 말고 **다시 저장**을 사용한다. 저장 중 새 선을 그려도 마지막 내용까지 저장 완료되는지 기다린다.

### 7. 작품 목록 이동

그림판의 **작품 목록** 링크로 돌아간다. 미저장 변경이 있다면 저장 완료 후 이동해야 한다. 작품 수정일이 갱신되는지도 확인한다.

### 8. 같은 작품 다시 열기

`PNG 저장 연습` 카드를 다시 누른다. 이전 선의 위치·색상·형태가 동일한지 확인한다. 지우개로 일부를 지우고 다시 저장 완료를 기다린 뒤 재열어도 지운 상태여야 한다.

### 9. F5 새로고침

저장 완료 표시를 확인한 다음 F5를 누른다. 로그인과 이미지 복원이 끝날 때까지 기다린다. 복원 중에는 새 그림 입력을 받지 않아야 한다.

### 10. 그림 복원 확인

새로고침 전의 그림과 동일한지 확인한다. 다른 작품을 새로 만들면 앞 작품의 픽셀이 보이지 않아야 한다.

원시 데이터는 `F12 → Application → IndexedDB → IntelligentCanvasLocal → canvasContents`에서 확인한다. `pngBlob`은 Blob이어야 하고 `width=1024`, `height=768`이어야 한다. 작품 이미지가 Firestore Emulator에 없는 것이 이번 단계의 정상 동작이다.
