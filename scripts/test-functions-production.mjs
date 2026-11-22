import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const fromFunctions = createRequire(new URL('../functions/package.json', import.meta.url))
const { resolveProductionConfig, assertProductionRuntime } = require('../functions/src/productionConfig.js')

// 오프라인 검증용 값이다. 이 테스트는 실제 자격 증명이나 Firebase 서버를 사용하지 않는다.
const projectId = 'offline-functions-check'
const storageBucket = `${projectId}.firebasestorage.app`
const origin = 'https://app.example.invalid'
const region = 'asia-northeast3'
const serviceAccount = `artwork-runtime@${projectId}.iam.gserviceaccount.com`
const config = {
  INTELLIGENTCANVAS_FUNCTIONS_MODE: 'production',
  INTELLIGENTCANVAS_PROJECT_ID: projectId,
  INTELLIGENTCANVAS_STORAGE_BUCKET: storageBucket,
  INTELLIGENTCANVAS_WEB_ORIGIN: origin,
  INTELLIGENTCANVAS_FUNCTIONS_REGION: region,
  INTELLIGENTCANVAS_SERVICE_ACCOUNT: serviceAccount,
  FIREBASE_CONFIG: JSON.stringify({ projectId, storageBucket }),
  GCLOUD_PROJECT: projectId,
}
const settings = { projectId, storageBucket, origin, region, serviceAccount }

test('production discovery requires an explicit project, bucket, region, web origin and service account', () => {
  assert.deepEqual(resolveProductionConfig(config), settings)
  for (const name of Object.keys(config).filter(key => key.startsWith('INTELLIGENTCANVAS_'))) {
    assert.throws(() => resolveProductionConfig({ ...config, [name]: undefined }), /\[Functions 설정\]/)
  }
  for (const value of ['http://localhost:5173', 'https://localhost', 'https://127.0.0.1', `${origin}/path`, `${origin}/*`]) {
    assert.throws(() => resolveProductionConfig({ ...config, INTELLIGENTCANVAS_WEB_ORIGIN: value }), /HTTPS 오리진/)
  }
  assert.throws(() => resolveProductionConfig({ ...config, INTELLIGENTCANVAS_STORAGE_BUCKET: 'other.firebasestorage.app' }), /Storage 버킷/)
  assert.throws(() => resolveProductionConfig({ ...config, INTELLIGENTCANVAS_SERVICE_ACCOUNT: 'runtime@other.iam.gserviceaccount.com' }), /서비스 계정/)
})

test('production refuses emulator configuration, mismatched projects and external credentials', () => {
  assert.throws(() => resolveProductionConfig({ ...config, GCLOUD_PROJECT: 'different-project' }), /프로젝트 ID/)
  assert.throws(() => resolveProductionConfig({ ...config, FIREBASE_CONFIG: 'not-json' }), /런타임 프로젝트 설정/)
  assert.throws(() => resolveProductionConfig({ ...config, FIREBASE_CONFIG: JSON.stringify({ projectId, storageBucket: 'other.appspot.com' }) }), /기본 버킷/)
  for (const key of ['FUNCTIONS_EMULATOR', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST',
    'FIREBASE_DEBUG_MODE', 'FIREBASE_DEBUG_FEATURES']) {
    assert.throws(() => resolveProductionConfig({ ...config, [key]: 'present' }), /Emulator/)
  }
  assert.throws(() => assertProductionRuntime(config, settings), /관리형 서비스 계정/)
  const runtime = { ...config, K_SERVICE: 'offline-fixture' }
  assert.doesNotThrow(() => assertProductionRuntime(runtime, settings))
  assert.throws(() => assertProductionRuntime({ ...runtime, FIREBASE_CONFIG: undefined }, settings), /런타임 프로젝트/)
  assert.throws(() => assertProductionRuntime({ ...runtime, GOOGLE_APPLICATION_CREDENTIALS: 'external-key.json' }, settings), /관리형 서비스 계정/)
})

test('production entry registers business APIs and rejects missing runtime, origin and user before database access', async t => {
  const { getApp, deleteApp } = fromFunctions('firebase-admin/app')
  const names = [...Object.keys(config), 'K_SERVICE', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT',
    'FUNCTIONS_EMULATOR', 'FIREBASE_EMULATOR_HUB', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST',
    'FIREBASE_STORAGE_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST', 'CLOUD_STORAGE_EMULATOR_HOST',
    'FIREBASE_DEBUG_MODE', 'FIREBASE_DEBUG_FEATURES']
  const original = new Map(names.map(name => [name, process.env[name]]))
  for (const name of names) delete process.env[name]
  Object.assign(process.env, config)
  let app
  t.after(async () => {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    if (app) await deleteApp(app)
  })
  const entry = require('../functions/src/index.js')
  app = getApp()
  assert.equal(app.options.projectId, projectId)
  assert.equal(app.options.storageBucket, storageBucket)
  assert.deepEqual(Object.keys(entry).sort(), [
    'acquireEditSession', 'beginEditSessionChanges', 'createServerArtwork', 'deleteServerArtwork', 'downloadArtworkPng',
    'finalizeArtworkSave', 'forceRecoverEditSession', 'getDeletedServerArtworks', 'getEditSessionStatus', 'getServerArtwork',
    'listArtworkRevisions', 'listServerArtworks', 'prepareArtworkSave', 'releaseEditSession', 'uploadArtworkPng',
  ])
  assert.deepEqual(entry.uploadArtworkPng.__endpoint.region, [region])
  assert.equal(entry.uploadArtworkPng.__endpoint.serviceAccountEmail, serviceAccount)
  assert.equal(entry.uploadArtworkPng.__endpoint.concurrency, 1)
  const request = { rawRequest: { get: () => origin }, data: {} }
  await assert.rejects(entry.prepareArtworkSave.run(request), { code: 'failed-precondition' })
  process.env.K_SERVICE = 'offline-fixture'
  await assert.rejects(entry.prepareArtworkSave.run(request), { code: 'unauthenticated' })
  await assert.rejects(entry.prepareArtworkSave.run({ ...request, rawRequest: { get: () => 'https://other.example.invalid' } }),
    { code: 'permission-denied' })

  const server = createServer((req, res) => {
    req.get = name => req.headers[name.toLowerCase()]
    res.status = status => { res.statusCode = status; return res }
    res.json = body => res.end(JSON.stringify(body))
    return entry.downloadArtworkPng(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}`
  const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin)
  const denied = await fetch(url, { headers: { Origin: 'https://app-example.invalid' } })
  assert.equal(denied.status, 403)
  assert.equal(denied.headers.get('access-control-allow-origin'), null)
  const signedOut = await fetch(url, { headers: { Origin: origin } })
  assert.equal(signedOut.status, 401)
  assert.equal((await signedOut.json()).code, 'unauthenticated')
})

test('production deployment template selects the protected rules, three indexes and the declared Node runtime', () => {
  const read = name => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'))
  const template = read('firebase.production.example.json')
  assert.deepEqual(template.firestore, { database: '(default)', rules: 'firestore.production.rules', indexes: 'firestore.indexes.json' })
  assert.deepEqual(template.storage, { rules: 'storage.production.rules' })
  assert.equal(template.functions.runtime, `nodejs${read('functions/package.json').engines.node}`)
  assert.deepEqual(read(template.firestore.indexes).indexes.map(index => index.fields.at(-1).fieldPath), ['updatedAt', 'createdAt', 'title'])
  assert.equal(template.emulators, undefined)
})
