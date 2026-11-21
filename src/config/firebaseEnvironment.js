export const firebaseEmulators = Object.freeze({
  projectId: 'ai-drawing-a9177',
  host: '127.0.0.1',
  auth: 'http://127.0.0.1:9099',
  firestorePort: 8080,
  storagePort: 9199,
  functionsPort: 5001,
  storageBucket: 'intelligentcanvas-stage5a-local.invalid',
  functionsRegion: 'asia-northeast3',
})

const fail = message => { throw new Error(`[Firebase 설정] ${message}`) }
const loopback = new Set(['localhost', '127.0.0.1', '[::1]'])

export function resolveFirebaseEnvironment(env, pageOrigin) {
  const value = name => env[`VITE_FIREBASE_${name}`]?.trim() ?? ''
  const legacy = env.VITE_USE_FIREBASE_EMULATORS
  const mode = value('MODE') || (env.DEV && legacy === 'true' ? 'emulator' : '')
  if (mode !== 'emulator' && mode !== 'production') {
    fail('VITE_FIREBASE_MODE를 emulator 또는 production으로 명시해 주세요. 운영 연결로 자동 전환하지 않습니다.')
  }
  if (legacy !== undefined && legacy !== (mode === 'emulator' ? 'true' : 'false')) {
    fail('VITE_FIREBASE_MODE와 기존 VITE_USE_FIREBASE_EMULATORS 설정이 일치하지 않습니다.')
  }
  if (mode === 'emulator' && !env.DEV) fail('Emulator 모드는 개발 서버에서만 실행할 수 있습니다.')
  if (mode === 'production' && (!env.PROD || env.DEV || value('ENABLE_PRODUCTION') !== 'true')) {
    fail('운영 Firebase 연결이 잠겨 있습니다. 승인된 운영 빌드에만 활성화할 수 있습니다.')
  }

  const origin = parseOrigin(pageOrigin)
  const config = {}
  const missing = []
  function requireValue(name) {
    const result = value(name)
    if (!result) missing.push(`VITE_FIREBASE_${name}`)
    return result
  }
  config.apiKey = requireValue('API_KEY')
  config.authDomain = requireValue('AUTH_DOMAIN')
  config.projectId = requireValue('PROJECT_ID')
  config.appId = requireValue('APP_ID')
  if (value('MESSAGING_SENDER_ID')) config.messagingSenderId = value('MESSAGING_SENDER_ID')
  let functionsRegion = firebaseEmulators.functionsRegion
  let functionsBaseUrl
  let expectedOrigin
  if (mode === 'production') {
    config.storageBucket = requireValue('STORAGE_BUCKET')
    config.messagingSenderId = requireValue('MESSAGING_SENDER_ID')
    functionsRegion = requireValue('FUNCTIONS_REGION')
    functionsBaseUrl = requireValue('FUNCTIONS_BASE_URL')
    expectedOrigin = requireValue('APP_ORIGIN')
  }
  if (missing.length) fail(`누락된 환경변수: ${missing.join(', ')}`)

  if (mode === 'emulator') {
    if (!loopback.has(origin.hostname)) fail('Emulator 모드는 로컬 브라우저 주소에서만 사용할 수 있습니다.')
    if (config.projectId !== firebaseEmulators.projectId) fail('Emulator 프로젝트 ID가 로컬 설정과 일치하지 않습니다.')
    config.storageBucket = firebaseEmulators.storageBucket
    functionsBaseUrl = `http://${firebaseEmulators.host}:${firebaseEmulators.functionsPort}/${config.projectId}/${functionsRegion}`
  } else {
    if (origin.protocol !== 'https:' || loopback.has(origin.hostname) || origin.origin !== expectedOrigin) {
      fail('운영 앱은 설정한 별도의 HTTPS 오리진에서만 실행할 수 있습니다.')
    }
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.projectId)
      || config.authDomain !== `${config.projectId}.firebaseapp.com`
      || !/^\d+$/.test(config.messagingSenderId)
      || config.appId.match(/^1:(\d+):web:[a-f0-9]+$/i)?.[1] !== config.messagingSenderId) {
      fail('Firebase 프로젝트 ID, 인증 도메인, 앱 ID 및 프로젝트 번호를 콘솔에서 대조해 주세요.')
    }
    if (![`${config.projectId}.firebasestorage.app`, `${config.projectId}.appspot.com`].includes(config.storageBucket)) {
      fail('운영 Firebase 프로젝트에서 확인한 기본 Storage 버킷 이름을 지정해 주세요.')
    }
    if (!/^[a-z]+-[a-z]+[0-9]+$/.test(functionsRegion)
      || functionsBaseUrl !== `https://${functionsRegion}-${config.projectId}.cloudfunctions.net`) {
      fail('Functions 기본 URL이 Firebase 프로젝트 ID 및 리전과 일치하지 않습니다.')
    }
  }
  return Object.freeze({ mode, config: Object.freeze(config), functionsRegion, functionsBaseUrl })
}

function parseOrigin(value) {
  try { return new URL(value) }
  catch { fail('브라우저 오리진을 확인하지 못했습니다.') }
}
