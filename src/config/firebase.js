import { deleteApp, getApps, initializeApp } from 'firebase/app'
import { beforeAuthStateChanged, browserLocalPersistence, connectAuthEmulator, initializeAuth, inMemoryPersistence } from 'firebase/auth'
import { connectFirestoreEmulator, getFirestore, terminate } from 'firebase/firestore'
import { withCanvasSaved } from '../services/pendingCanvasChanges'
import { firebaseEmulators } from './firebaseEnvironment'
import { firebaseAppName, requireFirebaseEnvironment } from './firebaseRuntime'

export const firebaseEnvironment = requireFirebaseEnvironment()

function configurationError(message) {
  return new Error(`[Firebase 설정] ${message}`)
}

export function assertEmulatorEnvironment() {
  if (firebaseEnvironment.mode !== 'emulator') throw configurationError('이 기능은 로컬 Emulator 전용입니다.')
}

// Vite HMR에서도 이미 연결한 인스턴스를 재사용한다.
const clientsByName = import.meta.hot?.data.firebaseClients ?? new Map()
if (import.meta.hot) {
  const signature = JSON.stringify(firebaseEnvironment)
  if (clientsByName.size && import.meta.hot.data.firebaseSignature !== signature) {
    throw configurationError('Firebase 연결 설정이 변경되었습니다. 페이지를 새로고침해 주세요.')
  }
  import.meta.hot.data.firebaseClients = clientsByName
  import.meta.hot.data.firebaseSignature = signature
}

function createClients(name) {
  if (clientsByName.has(name)) return clientsByName.get(name)
  // 이 모듈 밖에서 생성된 앱의 연결 대상은 신뢰하지 않는다.
  if (getApps().some((existing) => existing.name === name)) {
    throw configurationError('연결 대상을 확인할 수 없는 Firebase 앱이 있습니다. 페이지를 새로고침해 주세요.')
  }

  const app = initializeApp(firebaseEnvironment.config, name)
  // 일반 앱만 로그인 상태를 유지한다. 별도 테스트 앱은 기존처럼 메모리에 격리한다.
  const auth = initializeAuth(app, {
    persistence: name === firebaseAppName ? browserLocalPersistence : inMemoryPersistence,
  })
  if (firebaseEnvironment.mode === 'emulator') connectAuthEmulator(auth, firebaseEmulators.auth, { disableWarnings: true })
  if (name === firebaseAppName) {
    // SDK가 만료된 세션을 직접 반납할 때도 현재 편집의 로컬 저장을 기다린다.
    beforeAuthStateChanged(auth, nextUser => {
      if (!nextUser && auth.currentUser) return withCanvasSaved(() => {})
    })
  }
  const db = getFirestore(app)
  if (firebaseEnvironment.mode === 'emulator') connectFirestoreEmulator(db, firebaseEmulators.host, firebaseEmulators.firestorePort)

  const clients = { app, auth, db }
  clientsByName.set(name, clients)
  return clients
}

export function createEmulatorClients(name = '[DEFAULT]') {
  assertEmulatorEnvironment()
  return createClients(name)
}

export async function disposeEmulatorClients(clients) {
  assertEmulatorEnvironment()
  const name = clients.app.name
  try {
    await terminate(clients.db)
  } finally {
    await deleteApp(clients.app)
    clientsByName.delete(name)
  }
}

const defaultClients = createClients(firebaseAppName)
export const app = defaultClients.app
export const auth = defaultClients.auth
export const db = defaultClients.db
