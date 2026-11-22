import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, parseEnv } from 'node:util'
import { loadEnv } from 'vite'
import { firebaseEmulators, resolveFirebaseEnvironment } from '../src/config/firebaseEnvironment.js'

const require = createRequire(import.meta.url)
const { resolveProductionConfig } = require('../functions/src/productionConfig.js')
const projectPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/
const localConfig = new URL('../firebase.firebase-test.local.json', import.meta.url)

function checkProject(project) {
  if (!projectPattern.test(project ?? '') || project === firebaseEmulators.projectId) {
    throw new Error('--project에 별도의 Firebase 테스트 프로젝트 ID를 명시해 주세요.')
  }
}

export function checkFirebaseTestConfig(project, webEnv, functionsEnv, sdkConfig) {
  checkProject(project)
  const web = resolveFirebaseEnvironment({ ...webEnv, PROD: true, DEV: false }, webEnv.VITE_FIREBASE_APP_ORIGIN?.trim())
  const server = resolveProductionConfig(functionsEnv)
  if (web.mode !== 'production' || web.config.projectId !== project || server.projectId !== project) {
    throw new Error('--project, 웹 빌드, Functions의 프로젝트 ID를 일치시켜 주세요.')
  }
  if (web.config.storageBucket !== server.storageBucket || web.functionsRegion !== server.region
    || webEnv.VITE_FIREBASE_APP_ORIGIN.trim() !== server.origin) {
    throw new Error('웹과 Functions의 버킷, 리전, HTTPS 오리진을 일치시켜 주세요.')
  }
  for (const field of ['projectId', 'apiKey', 'authDomain', 'appId', 'messagingSenderId', 'storageBucket']) {
    if (web.config[field] !== sdkConfig?.[field]) throw new Error(`Console에서 받은 Web App 설정과 ${field} 값이 다릅니다.`)
  }
  return { project, bucket: server.storageBucket, region: server.region, webOrigin: server.origin }
}

export function prepareFirebaseTestDeployConfig(template, checked) {
  const { project, bucket, webOrigin } = checked
  checkProject(project)
  if (![`https://${project}.web.app`, `https://${project}.firebaseapp.com`].includes(webOrigin)) {
    throw new Error('배포 설정을 생성하려면 Console에서 확인한 테스트 프로젝트 기본 Hosting의 HTTPS 오리진을 웹과 Functions에 지정해 주세요.')
  }
  const predeploy = [`node scripts/check-firebase-test-config.mjs --project ${project} --assert-target`]
  return {
    ...template,
    firestore: { ...template.firestore, predeploy },
    functions: { ...template.functions, predeploy },
    storage: [{ bucket, rules: template.storage.rules, predeploy }],
    hosting: { ...template.hosting, site: project, predeploy },
  }
}

function run() {
  const { values } = parseArgs({
    options: {
      project: { type: 'string' }, 'web-config': { type: 'string' },
      'prepare-config': { type: 'boolean' }, 'assert-target': { type: 'boolean' },
    },
  })
  const project = values.project
  checkProject(project)
  if (values['assert-target']) {
    // Firebase CLI는 사전 배포 프로세스의 GCLOUD_PROJECT에 실제 대상을 제공한다.
    if (process.env.GCLOUD_PROJECT !== project) throw new Error('배포 대상이 사전 검사에서 승인한 테스트 프로젝트와 다릅니다.')
    return
  }
  if (!values['web-config']) throw new Error('--web-config에 테스트 Web App의 SDK 설정 JSON 파일을 지정해 주세요.')

  const root = new URL('../', import.meta.url)
  const webEnv = loadEnv('firebase-test', fileURLToPath(root), 'VITE_')
  if ((process.env.NODE_ENV && process.env.NODE_ENV !== 'production') || process.env.VITE_USER_NODE_ENV === 'development') {
    throw new Error('firebase-test는 NODE_ENV=production으로 빌드해야 합니다.')
  }
  const projectEnv = new URL(`functions/.env.${project}`, root)
  if (!existsSync(projectEnv)) throw new Error('functions/.env.<테스트 프로젝트 ID> 파일이 필요합니다.')
  const genericEnv = new URL('functions/.env', root)
  const readEnv = file => parseEnv(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  const functionsEnv = {
    ...(existsSync(genericEnv) ? readEnv(genericEnv) : {}),
    ...readEnv(projectEnv),
  }
  for (const key of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'FIREBASE_CONFIG', 'K_SERVICE', 'GOOGLE_APPLICATION_CREDENTIALS']) {
    if (Object.hasOwn(functionsEnv, key)) throw new Error(`Functions 환경 파일에서 예약 또는 자격 증명 변수 ${key}를 제거해 주세요.`)
  }
  const readJson = path => {
    try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) }
    catch { throw new Error('설정 파일을 읽을 수 없거나 JSON 형식이 올바르지 않습니다.') }
  }
  const exported = readJson(resolve(values['web-config']))
  const checked = checkFirebaseTestConfig(project, webEnv, { ...process.env, ...functionsEnv },
    exported?.result?.sdkConfig ?? exported?.sdkConfig ?? exported)
  if (values['prepare-config']) {
    const template = readJson(new URL('firebase.production.example.json', root))
    const config = prepareFirebaseTestDeployConfig(template, checked)
    writeFileSync(localConfig, JSON.stringify(config, null, 2) + '\n')
  }
  console.log(JSON.stringify({ ...checked, preparedConfig: values['prepare-config'] ? 'firebase.firebase-test.local.json' : null,
    cloudVerified: false }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { run() }
  catch (error) {
    // 환경 값이나 JSON 원문을 출력하지 않는다.
    console.error(error.message)
    process.exitCode = 1
  }
}
