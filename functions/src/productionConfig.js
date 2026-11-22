const { isIP } = require('node:net')

const modeName = 'INTELLIGENTCANVAS_FUNCTIONS_MODE'
const emulatorKeys = [
  'FUNCTIONS_EMULATOR', 'FIREBASE_EMULATOR_HUB', 'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST',
  'STORAGE_EMULATOR_HOST', 'CLOUD_STORAGE_EMULATOR_HOST',
  'FIREBASE_DEBUG_MODE', 'FIREBASE_DEBUG_FEATURES',
]
const projectIdPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/

function configurationError(message) {
  return new Error(`[Functions 설정] ${message}`)
}

function checkPlatform(env, settings, runtime) {
  if (env[modeName] !== 'production' || emulatorKeys.some(name => env[name])) {
    throw configurationError('운영 Functions와 Emulator 설정을 함께 사용할 수 없습니다.')
  }
  for (const key of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) {
    if (env[key] && env[key] !== settings.projectId) throw configurationError('실행 프로젝트 ID가 운영 설정과 다릅니다.')
  }
  if (env.FIREBASE_CONFIG || runtime) {
    let platform
    try { platform = JSON.parse(env.FIREBASE_CONFIG) }
    catch { throw configurationError('Firebase 런타임 프로젝트 설정을 확인해 주세요.') }
    if (platform?.projectId !== settings.projectId
      || (platform.storageBucket && platform.storageBucket !== settings.storageBucket)) {
      throw configurationError('Firebase 런타임 프로젝트 또는 기본 버킷이 운영 설정과 다릅니다.')
    }
  }
  if (runtime && (!env.K_SERVICE || env.GOOGLE_APPLICATION_CREDENTIALS)) {
    throw configurationError('관리형 서비스 계정을 사용하는 운영 Functions 런타임이 필요합니다.')
  }
}

function resolveProductionConfig(env) {
  const read = name => env[`INTELLIGENTCANVAS_${name}`]?.trim() ?? ''
  const projectId = read('PROJECT_ID')
  const storageBucket = read('STORAGE_BUCKET')
  const region = read('FUNCTIONS_REGION')
  const origin = read('WEB_ORIGIN')
  const serviceAccount = read('SERVICE_ACCOUNT')
  if (!projectIdPattern.test(projectId)) throw configurationError('운영 프로젝트 ID를 지정해 주세요.')
  if (![`${projectId}.firebasestorage.app`, `${projectId}.appspot.com`].includes(storageBucket)) {
    throw configurationError('같은 프로젝트의 승인된 기본 Storage 버킷을 지정해 주세요.')
  }
  if (!/^[a-z]+-[a-z]+[0-9]+$/.test(region)) throw configurationError('Functions 리전을 지정해 주세요.')
  let url
  try { url = new URL(origin) } catch { throw configurationError('운영 웹 HTTPS 오리진을 지정해 주세요.') }
  if (url.origin !== origin || url.protocol !== 'https:' || url.hostname === 'localhost'
    || url.hostname.endsWith('.localhost') || isIP(url.hostname.replace(/^\[|\]$/g, ''))) {
    throw configurationError('운영 웹의 정확한 HTTPS 오리진을 지정해 주세요.')
  }
  const [account] = serviceAccount.split('@')
  if (!projectIdPattern.test(account) || serviceAccount !== `${account}@${projectId}.iam.gserviceaccount.com`) {
    throw configurationError('같은 프로젝트의 전용 Functions 서비스 계정을 지정해 주세요.')
  }
  const settings = { projectId, storageBucket, region, origin, serviceAccount }
  checkPlatform(env, settings, false)
  return Object.freeze(settings)
}

function assertProductionRuntime(env, settings) {
  checkPlatform(env, settings, true)
}

module.exports = { modeName, resolveProductionConfig, assertProductionRuntime }
