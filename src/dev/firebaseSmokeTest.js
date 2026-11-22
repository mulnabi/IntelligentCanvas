import { createUserWithEmailAndPassword, deleteUser, signInWithEmailAndPassword, signOut } from 'firebase/auth'
import { deleteDoc, doc, getDocFromServer, serverTimestamp, setDoc, terminate, Timestamp } from 'firebase/firestore'
import { assertEmulatorEnvironment, createEmulatorClients, disposeEmulatorClients } from '../config/firebase'

const checkNames = [
  'Firebase 초기화',
  'Auth Emulator 가입·로그인',
  'Firestore Emulator 문서 저장',
  '서버 조회·데이터 일치',
  '다른 UID 인증',
  '다른 UID 조회 차단',
  '다른 UID 생성 차단',
  '다른 UID 삭제 차단',
  '비로그인 조회 차단',
  '비로그인 생성 차단',
  '잘못된 문서 형식 차단',
  '작품·세션·수정 이력 쓰기 차단',
  '원본 테스트 문서 유지',
  '테스트 데이터 정리',
]

function timeout(operation, milliseconds = 10000) {
  let timer
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('검증 시간 초과: Emulator 실행 상태와 포트를 확인해 주세요.')), milliseconds)
    }),
  ]).finally(() => clearTimeout(timer))
}

function safeError(error) {
  if (error?.code === 'permission-denied') return '권한 거부: firestore.rules가 Emulator에 반영되었는지 확인해 주세요.'
  if (error?.code === 'auth/network-request-failed' || error?.code === 'unavailable') {
    return 'Emulator에 연결할 수 없습니다. 9099·8081 포트를 확인해 주세요.'
  }
  // SDK 오류 전체에는 요청 정보가 포함될 수 있으므로 출력하지 않는다.
  if (error?.code) return `Firebase 오류 (${String(error.code).replace(/[^a-zA-Z0-9/_-]/g, '')})`
  return error instanceof Error ? error.message : '검증 중 알 수 없는 오류가 발생했습니다.'
}

async function expectDenied(operation) {
  try {
    await timeout(operation())
  } catch (error) {
    if (error?.code === 'permission-denied') return
    throw error // 네트워크 오류는 접근 차단 성공으로 취급하지 않는다.
  }
  throw new Error('차단되어야 할 요청이 허용되었습니다. 보안 규칙을 확인해 주세요.')
}

function assertSnapshot(snapshot, expected) {
  if (!snapshot.exists()) throw new Error('저장한 테스트 문서가 서버에 없습니다.')
  const actual = snapshot.data()
  const expectedKeys = [...Object.keys(expected), 'createdAt'].sort()
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(expectedKeys)
    || Object.entries(expected).some(([key, value]) => actual[key] !== value)
    || !(actual.createdAt instanceof Timestamp)) {
    throw new Error('저장한 데이터와 서버 조회 결과가 일치하지 않습니다.')
  }
}

let activeRun

// import만으로는 인증·문서 생성이 실행되지 않는다. 중복 호출은 같은 실행을 기다린다.
export function runFirebaseSmokeTest(options = {}) {
  if (activeRun) return activeRun
  activeRun = executeSmokeTest(options).finally(() => { activeRun = undefined })
  return activeRun
}

async function executeSmokeTest({ keepTestData = false } = {}) {
  const report = {
    success: false,
    runId: crypto.randomUUID(),
    documentPath: null,
    checks: checkNames.map((name) => ({ name, status: '미검증', detail: '' })),
  }
  const clients = []
  const createdUsers = []
  const createdDocuments = []
  let currentCheck
  let owner
  let other
  let guest
  let expected

  async function check(name, operation) {
    currentCheck = report.checks.find((item) => item.name === name)
    await operation()
    currentCheck.status = '성공'
  }

  function payload(runId = report.runId) {
    return { ...expected, runId, createdAt: serverTimestamp() }
  }

  async function forbiddenCreate(client, path, data) {
    await expectDenied(async () => {
      const reference = doc(client.db, path)
      await setDoc(reference, data)
      // 규칙이 잘못되어 쓰기가 성공해도 이번 실행의 데이터만 정리한다.
      createdDocuments.push(doc(owner.db, path))
    })
  }

  try {
    await check('Firebase 초기화', async () => {
      assertEmulatorEnvironment()
      owner = createEmulatorClients(`smoke-owner-${report.runId}`)
      clients.push(owner)
      other = createEmulatorClients(`smoke-other-${report.runId}`)
      clients.push(other)
      guest = createEmulatorClients(`smoke-guest-${report.runId}`)
      clients.push(guest)
    })

    await check('Auth Emulator 가입·로그인', async () => {
      const email = `smoke-owner-${report.runId}@example.test`
      const password = `Smoke-${crypto.randomUUID()}`
      const credential = await timeout(createUserWithEmailAndPassword(owner.auth, email, password))
      createdUsers.push(credential.user)
      const uid = credential.user.uid
      await timeout(signOut(owner.auth))
      const signedIn = await timeout(signInWithEmailAndPassword(owner.auth, email, password))
      createdUsers[0] = signedIn.user
      if (signedIn.user.uid !== uid) throw new Error('가입한 사용자와 로그인한 사용자 UID가 다릅니다.')
      expected = { ownerUid: uid, runId: report.runId, environment: 'emulator', message: 'IntelligentCanvas 연결 확인' }
      report.documentPath = `users/${uid}/connectionTests/${report.runId}`
    })

    await check('Firestore Emulator 문서 저장', async () => {
      const reference = doc(owner.db, report.documentPath)
      createdDocuments.push(reference)
      await timeout(setDoc(reference, payload()))
    })
    await check('서버 조회·데이터 일치', async () => {
      assertSnapshot(await timeout(getDocFromServer(doc(owner.db, report.documentPath))), expected)
    })
    await check('다른 UID 인증', async () => {
      const credential = await timeout(createUserWithEmailAndPassword(
        other.auth, `smoke-other-${report.runId}@example.test`, `Smoke-${crypto.randomUUID()}`,
      ))
      createdUsers.push(credential.user)
      if (credential.user.uid === expected.ownerUid) throw new Error('다른 사용자 UID 생성에 실패했습니다.')
    })
    await check('다른 UID 조회 차단', () => expectDenied(() => getDocFromServer(doc(other.db, report.documentPath))))
    await check('다른 UID 생성 차단', () => forbiddenCreate(
      other, `users/${expected.ownerUid}/connectionTests/other-${report.runId}`, payload(`other-${report.runId}`),
    ))
    await check('다른 UID 삭제 차단', () => expectDenied(() => deleteDoc(doc(other.db, report.documentPath))))
    // 일반 앱의 Firestore 연결도 열려 있을 수 있으므로 끝난 테스트의 스트림을 먼저 정리한다.
    // Auth 인스턴스는 계정 삭제를 위해 finally까지 유지한다.
    await timeout(terminate(other.db))
    await check('비로그인 조회 차단', async () => {
      if (guest.auth.currentUser !== null) throw new Error('비로그인 검증 인스턴스에 사용자가 존재합니다.')
      await expectDenied(() => getDocFromServer(doc(guest.db, report.documentPath)))
    })
    await check('비로그인 생성 차단', () => forbiddenCreate(
      guest, `users/${expected.ownerUid}/connectionTests/guest-${report.runId}`, payload(`guest-${report.runId}`),
    ))
    await timeout(terminate(guest.db))
    await check('잘못된 문서 형식 차단', () => forbiddenCreate(
      owner, `users/${expected.ownerUid}/connectionTests/invalid-${report.runId}`,
      { ...payload(`invalid-${report.runId}`), unexpectedField: true },
    ))
    await check('작품·세션·수정 이력 쓰기 차단', async () => {
      const artworkPath = `users/${expected.ownerUid}/artworks/smoke-${report.runId}`
      for (const path of [artworkPath, `${artworkPath}/editSession/current`, `${artworkPath}/revisions/${report.runId}`]) {
        await forbiddenCreate(owner, path, payload())
      }
    })
    await check('원본 테스트 문서 유지', async () => {
      assertSnapshot(await timeout(getDocFromServer(doc(owner.db, report.documentPath))), expected)
    })
  } catch (error) {
    if (currentCheck) {
      currentCheck.status = '실패'
      currentCheck.detail = safeError(error)
    }
  } finally {
    const cleanup = report.checks.find((item) => item.name === '테스트 데이터 정리')
    const cleanupErrors = []
    if (!keepTestData) {
      for (const reference of createdDocuments) {
        try { await timeout(deleteDoc(reference)) } catch (error) { cleanupErrors.push(safeError(error)) }
      }
      for (const user of createdUsers) {
        try { await timeout(deleteUser(user)) } catch (error) { cleanupErrors.push(safeError(error)) }
      }
    }
    for (const client of clients) {
      try { await timeout(disposeEmulatorClients(client)) } catch (error) { cleanupErrors.push(safeError(error)) }
    }
    cleanup.status = cleanupErrors.length ? '실패' : '성공'
    cleanup.detail = cleanupErrors.length
      ? `일부 테스트 데이터 또는 연결 정리 실패: ${cleanupErrors.join(' / ')}`
      : keepTestData ? '요청에 따라 테스트 계정·문서를 Emulator에 보존. 연결은 종료했습니다.' : '이번 실행의 계정·문서·연결만 정리했습니다.'
  }

  report.success = report.checks.every((item) => item.status === '성공')
  console.table(report.checks)
  console.info(report.success ? 'Firebase Emulator 검증 성공' : 'Firebase Emulator 검증 실패 — 실패 및 미검증 항목을 확인해 주세요.')
  return report
}
