import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { firebaseEmulators, resolveFirebaseEnvironment } from '../src/config/firebaseEnvironment.js'

const localOrigin = 'http://127.0.0.1:5173'
const local = {
  DEV: true, PROD: false,
  VITE_USE_FIREBASE_EMULATORS: 'true',
  VITE_FIREBASE_API_KEY: 'unit-test-web-key',
  VITE_FIREBASE_AUTH_DOMAIN: 'unit-test-auth.example.invalid',
  VITE_FIREBASE_PROJECT_ID: firebaseEmulators.projectId,
  VITE_FIREBASE_APP_ID: 'unit-test-app-id',
}
// 파서 단위 검증 값이다. 이 스크립트는 웹 SDK를 초기화하거나 네트워크에 접속하지 않는다.
const production = {
  DEV: false, PROD: true,
  VITE_FIREBASE_MODE: 'production', VITE_USE_FIREBASE_EMULATORS: 'false',
  VITE_FIREBASE_ENABLE_PRODUCTION: 'true',
  VITE_FIREBASE_APP_ORIGIN: 'https://app.example.invalid',
  VITE_FIREBASE_API_KEY: 'unit-test-web-key',
  VITE_FIREBASE_PROJECT_ID: 'example-unconnected',
  VITE_FIREBASE_AUTH_DOMAIN: 'example-unconnected.firebaseapp.com',
  VITE_FIREBASE_APP_ID: '1:1234:web:0123456789abcdef',
  VITE_FIREBASE_MESSAGING_SENDER_ID: '1234',
  VITE_FIREBASE_FUNCTIONS_REGION: 'asia-northeast3',
  VITE_FIREBASE_FUNCTIONS_BASE_URL: 'https://asia-northeast3-example-unconnected.cloudfunctions.net',
  VITE_FIREBASE_STORAGE_BUCKET: 'example-unconnected.firebasestorage.app',
}

test('legacy development mode resolves only the existing loopback project and bucket', () => {
  const result = resolveFirebaseEnvironment({
    ...local,
    VITE_FIREBASE_STORAGE_BUCKET: production.VITE_FIREBASE_STORAGE_BUCKET,
    VITE_FIREBASE_FUNCTIONS_BASE_URL: production.VITE_FIREBASE_FUNCTIONS_BASE_URL,
    VITE_FIREBASE_FUNCTIONS_REGION: 'us-central1',
  }, localOrigin)
  assert.equal(result.mode, 'emulator')
  assert.equal(result.config.storageBucket, firebaseEmulators.storageBucket)
  assert.equal(result.functionsRegion, firebaseEmulators.functionsRegion)
  assert.equal(result.functionsBaseUrl, 'http://127.0.0.1:5001/ai-drawing-a9177/asia-northeast3')
})

test('explicit local mode rejects wrong project, legacy flag, nonlocal origin and build mode', () => {
  const settings = { ...local, VITE_FIREBASE_MODE: 'emulator' }
  assert.equal(resolveFirebaseEnvironment(settings, localOrigin).mode, 'emulator')
  assert.throws(() => resolveFirebaseEnvironment({ ...settings, VITE_FIREBASE_PROJECT_ID: 'different' }, localOrigin), /프로젝트 ID/)
  assert.throws(() => resolveFirebaseEnvironment({ ...settings, VITE_USE_FIREBASE_EMULATORS: 'false' }, localOrigin), /일치하지/)
  assert.throws(() => resolveFirebaseEnvironment(settings, production.VITE_FIREBASE_APP_ORIGIN), /로컬 브라우저/)
  assert.throws(() => resolveFirebaseEnvironment({ ...settings, DEV: false, PROD: true }, localOrigin), /개발 서버/)
})

test('a default build, missing mode and incomplete settings fail before SDK setup', () => {
  assert.throws(() => resolveFirebaseEnvironment({ ...local, DEV: false, PROD: true }, localOrigin), /VITE_FIREBASE_MODE/)
  assert.throws(() => resolveFirebaseEnvironment({ ...local, VITE_USE_FIREBASE_EMULATORS: undefined }, localOrigin), /VITE_FIREBASE_MODE/)
  assert.throws(() => resolveFirebaseEnvironment({ ...local, VITE_FIREBASE_API_KEY: '' }, localOrigin), /VITE_FIREBASE_API_KEY/)
  assert.throws(() => resolveFirebaseEnvironment({ ...local, VITE_FIREBASE_MODE: 'other' }, localOrigin), /VITE_FIREBASE_MODE/)
})

test('production is explicitly enabled with every real setting required', () => {
  const origin = production.VITE_FIREBASE_APP_ORIGIN
  for (const settings of [{ VITE_FIREBASE_ENABLE_PRODUCTION: undefined }, { DEV: true }, { PROD: false }]) {
    assert.throws(() => resolveFirebaseEnvironment({ ...production, ...settings }, origin), /잠겨/)
  }
  for (const name of ['STORAGE_BUCKET', 'FUNCTIONS_REGION', 'FUNCTIONS_BASE_URL', 'APP_ORIGIN', 'MESSAGING_SENDER_ID']) {
    assert.throws(() => resolveFirebaseEnvironment({
      ...production, [`VITE_FIREBASE_${name}`]: '',
    }, origin), new RegExp(`VITE_FIREBASE_${name}`))
  }
  const result = resolveFirebaseEnvironment(production, origin)
  assert.equal(result.mode, 'production')
  assert.equal(result.functionsBaseUrl, production.VITE_FIREBASE_FUNCTIONS_BASE_URL)
  assert.equal(result.config.storageBucket, production.VITE_FIREBASE_STORAGE_BUCKET)
})

test('production rejects mixed Auth, Firestore project, Storage and Functions settings', () => {
  const origin = production.VITE_FIREBASE_APP_ORIGIN
  const changes = [
    { VITE_FIREBASE_AUTH_DOMAIN: 'other-project.firebaseapp.com' },
    { VITE_FIREBASE_PROJECT_ID: 'other-project' },
    { VITE_FIREBASE_MESSAGING_SENDER_ID: '9999' },
    { VITE_FIREBASE_STORAGE_BUCKET: firebaseEmulators.storageBucket },
    { VITE_FIREBASE_FUNCTIONS_BASE_URL: 'http://127.0.0.1:5001/wrong-project' },
    { VITE_FIREBASE_FUNCTIONS_REGION: 'us-central1' },
    { VITE_USE_FIREBASE_EMULATORS: 'true' },
  ]
  for (const change of changes) assert.throws(() => resolveFirebaseEnvironment({ ...production, ...change }, origin), /\[Firebase 설정\]/)
  assert.throws(() => resolveFirebaseEnvironment(production, localOrigin), /HTTPS 오리진/)
})

test('the current Functions entry point registers no functions outside Emulator discovery', () => {
  const require = createRequire(import.meta.url)
  const entry = require.resolve('../functions/src/index.js')
  const old = process.env.FUNCTIONS_EMULATOR
  delete process.env.FUNCTIONS_EMULATOR
  try {
    assert.deepEqual(Object.keys(require(entry)), [])
    delete require.cache[entry]
    process.env.FUNCTIONS_EMULATOR = 'true'
    const localExports = require(entry)
    for (const name of ['checkServerEnvironment', 'cleanupArtworkStaging', 'acquireEditSession', 'uploadArtworkPng']) {
      assert.equal(typeof localExports[name], 'function')
    }
  } finally {
    delete require.cache[entry]
    if (old === undefined) delete process.env.FUNCTIONS_EMULATOR
    else process.env.FUNCTIONS_EMULATOR = old
  }
})

test('production rules preserve common Firestore rules and remove dev grants', () => {
  const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const firestore = read('firestore.production.rules')
  const local = read('firestore.rules')
  const profiles = local.split('    // 1단계')[0]
  const artworks = local.split('    match /users/{uid}/artworks/')[1].split('    // 세션 토큰')[0]
  assert.ok(firestore.startsWith(profiles))
  assert.ok(firestore.includes(`    match /users/{uid}/artworks/${artworks}`))
  assert.doesNotMatch(firestore, /connectionTests/)
  const storage = read('storage.production.rules')
  assert.doesNotMatch(storage, /_emulatorChecks|allow .*if true/)
  assert.match(storage, /allow read, write: if false;/)
})
