import { deleteApp, getApps, initializeApp } from 'firebase/app'
import { connectAuthEmulator, initializeAuth, inMemoryPersistence } from 'firebase/auth'
import { connectFirestoreEmulator, getFirestore, terminate } from 'firebase/firestore'

export const firebaseEmulators = Object.freeze({
  auth: 'http://127.0.0.1:9099',
  firestoreHost: '127.0.0.1',
  firestorePort: 8080,
})

function configurationError(message) {
  return new Error(`[Firebase 설정] ${message}`)
}

// 1단계에서는 운영 연결을 제공하지 않는다. 실패 시 운영으로 전환하지 않는다.
export function assertEmulatorEnvironment() {
  if (!import.meta.env.DEV) {
    throw configurationError('현재 Firebase 모듈은 개발용 Emulator에서만 사용할 수 있습니다.')
  }
  if (import.meta.env.VITE_USE_FIREBASE_EMULATORS !== 'true') {
    throw configurationError('.env.local에 VITE_USE_FIREBASE_EMULATORS=true를 설정하고 개발 서버를 재시작해 주세요.')
  }
}

function readFirebaseConfig() {
  const required = {
    apiKey: 'VITE_FIREBASE_API_KEY',
    authDomain: 'VITE_FIREBASE_AUTH_DOMAIN',
    projectId: 'VITE_FIREBASE_PROJECT_ID',
    appId: 'VITE_FIREBASE_APP_ID',
  }
  const config = {}
  const missing = []
  for (const [field, variable] of Object.entries(required)) {
    const value = import.meta.env[variable]?.trim()
    if (!value) missing.push(variable)
    else config[field] = value
  }
  if (missing.length) {
    throw configurationError(`누락된 환경변수: ${missing.join(', ')}. .env.local을 저장하고 개발 서버를 재시작해 주세요.`)
  }
  if (config.projectId !== 'ai-drawing-a9177') {
    throw configurationError('VITE_FIREBASE_PROJECT_ID가 기존 프로젝트 ai-drawing-a9177과 일치해야 합니다.')
  }
  // 두 항목은 SDK 설정을 보존하기 위한 것으로, 해당 서비스를 초기화하지 않는다.
  if (import.meta.env.VITE_FIREBASE_STORAGE_BUCKET?.trim()) {
    config.storageBucket = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET.trim()
  }
  if (import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim()) {
    config.messagingSenderId = import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID.trim()
  }
  return config
}

assertEmulatorEnvironment()
const firebaseConfig = readFirebaseConfig()

// Vite HMR에서도 이미 연결한 인스턴스를 재사용한다.
const clientsByName = import.meta.hot?.data.firebaseClients ?? new Map()
if (import.meta.hot) import.meta.hot.data.firebaseClients = clientsByName

export function createEmulatorClients(name = '[DEFAULT]') {
  assertEmulatorEnvironment()
  if (clientsByName.has(name)) return clientsByName.get(name)
  // 이 모듈 밖에서 생성된 앱의 연결 대상은 신뢰하지 않는다.
  if (getApps().some((existing) => existing.name === name)) {
    throw configurationError('연결 대상을 확인할 수 없는 Firebase 앱이 있습니다. 페이지를 새로고침해 주세요.')
  }

  const app = initializeApp(firebaseConfig, name)
  const auth = initializeAuth(app, { persistence: inMemoryPersistence })
  connectAuthEmulator(auth, firebaseEmulators.auth, { disableWarnings: true })
  const db = getFirestore(app)
  connectFirestoreEmulator(db, firebaseEmulators.firestoreHost, firebaseEmulators.firestorePort)

  const clients = { app, auth, db }
  clientsByName.set(name, clients)
  return clients
}

export async function disposeEmulatorClients(clients) {
  const name = clients.app.name
  try {
    await terminate(clients.db)
  } finally {
    await deleteApp(clients.app)
    clientsByName.delete(name)
  }
}

const defaultClients = createEmulatorClients()
export const app = defaultClients.app
export const auth = defaultClients.auth
export const db = defaultClients.db
