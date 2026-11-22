import { resolveFirebaseEnvironment } from './firebaseEnvironment'

// Vite에 공개할 앱 설정을 명시한다. 참조하지 않는 환경변수까지 번들에 넣지 않는다.
const publicSettings = {
  DEV: import.meta.env.DEV,
  PROD: import.meta.env.PROD,
  VITE_USE_FIREBASE_EMULATORS: import.meta.env.VITE_USE_FIREBASE_EMULATORS,
  VITE_FIREBASE_MODE: import.meta.env.VITE_FIREBASE_MODE,
  VITE_FIREBASE_ENABLE_PRODUCTION: import.meta.env.VITE_FIREBASE_ENABLE_PRODUCTION,
  VITE_FIREBASE_API_KEY: import.meta.env.VITE_FIREBASE_API_KEY,
  VITE_FIREBASE_AUTH_DOMAIN: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  VITE_FIREBASE_PROJECT_ID: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  VITE_FIREBASE_APP_ID: import.meta.env.VITE_FIREBASE_APP_ID,
  VITE_FIREBASE_MESSAGING_SENDER_ID: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  VITE_FIREBASE_STORAGE_BUCKET: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  VITE_FIREBASE_FUNCTIONS_REGION: import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION,
  VITE_FIREBASE_FUNCTIONS_BASE_URL: import.meta.env.VITE_FIREBASE_FUNCTIONS_BASE_URL,
  VITE_FIREBASE_APP_ORIGIN: import.meta.env.VITE_FIREBASE_APP_ORIGIN,
}

let environment
let configurationError
try {
  environment = resolveFirebaseEnvironment(publicSettings, globalThis.location?.origin)
} catch (error) {
  // 설정 오류는 Firebase 초기화 때 UI로 전달한다.
  configurationError = error
}

export function requireFirebaseEnvironment() {
  if (configurationError) throw configurationError
  return environment
}

const cloudScope = environment?.mode === 'production' ? `cloud-${environment.config.projectId}` : null
export const firebaseAppName = cloudScope ? `intelligentcanvas-${cloudScope}` : '[DEFAULT]'
const storageScope = environment?.mode === 'emulator' ? '' : `-${cloudScope ?? 'unconfigured'}`
export const firebaseBrowserStorage = Object.freeze({
  databaseName: `IntelligentCanvasLocal${storageScope}`,
  keyPrefix: `intelligentcanvas${storageScope}`,
  enabled: Boolean(environment),
})
