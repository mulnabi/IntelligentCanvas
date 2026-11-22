const { applicationDefault, getApps, initializeApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const { getStorage } = require('firebase-admin/storage')
const { HttpsError } = require('firebase-functions/v2/https')
const { getLocalApp, localAdminAvailable } = require('./localFirestore')
const { assertProductionRuntime } = require('../productionConfig')

let production

function configureProductionAdmin(settings) {
  if (production || getApps().length) throw new Error('[Functions 설정] 기존 Admin 앱의 연결 대상을 확인할 수 없습니다.')
  const { projectId, storageBucket } = settings
  // Callable SDK와 바이너리 핸들러 모두 이 기본 앱의 토큰 대상 프로젝트를 사용한다.
  const app = initializeApp({ projectId, storageBucket, credential: applicationDefault() })
  production = { settings, app }
}

function assertAdminAvailable() {
  if (production) {
    try { assertProductionRuntime(process.env, production.settings) }
    catch { throw new HttpsError('failed-precondition', '운영 Functions 런타임 설정을 확인해 주세요.') }
  } else if (!localAdminAvailable()) {
    throw new HttpsError('failed-precondition', '로컬 Emulator 연결이 필요합니다.')
  }
}

function getAdminApp() {
  assertAdminAvailable()
  return production?.app ?? getLocalApp()
}

const getAdminFirestore = () => getFirestore(getAdminApp())

function getArtworkBucket() {
  const app = getAdminApp()
  if (production) return getStorage(app).bucket(production.settings.storageBucket)
  if (process.env.FIREBASE_STORAGE_EMULATOR_HOST !== '127.0.0.1:9199'
    || process.env.STORAGE_EMULATOR_HOST !== 'http://127.0.0.1:9199') {
    // SDK는 STORAGE_EMULATOR_HOST를 사용한다. 분리 실행 시 Firebase가 주입한 URL도 확인한다.
    if (process.env.FIREBASE_STORAGE_EMULATOR_HOST !== '127.0.0.1:9199'
      || process.env.CLOUD_STORAGE_EMULATOR_HOST !== 'http://127.0.0.1:9199') {
      throw new HttpsError('failed-precondition', '로컬 Storage Emulator 연결을 확인해 주세요.')
    }
    process.env.STORAGE_EMULATOR_HOST = 'http://127.0.0.1:9199'
  }
  return getStorage(app).bucket('intelligentcanvas-stage5a-local.invalid')
}

module.exports = { configureProductionAdmin, assertAdminAvailable, getAdminApp, getAdminFirestore, getArtworkBucket }
