import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkFirebaseTestConfig, prepareFirebaseTestDeployConfig } from './check-firebase-test-config.mjs'
import { firebaseEmulators } from '../src/config/firebaseEnvironment.js'

const project = 'offline-stage11-check'
const origin = 'https://stage11.example.invalid'
const region = 'asia-northeast3'
const sdk = {
  projectId: project, apiKey: 'offline-stage11-web-key', authDomain: `${project}.firebaseapp.com`,
  appId: '1:112233:web:0123456789abcd', messagingSenderId: '112233', storageBucket: `${project}.firebasestorage.app`,
}
const web = {
  VITE_FIREBASE_MODE: 'production', VITE_USE_FIREBASE_EMULATORS: 'false', VITE_FIREBASE_ENABLE_PRODUCTION: 'true',
  VITE_FIREBASE_APP_ORIGIN: origin, VITE_FIREBASE_PROJECT_ID: project, VITE_FIREBASE_API_KEY: sdk.apiKey,
  VITE_FIREBASE_AUTH_DOMAIN: sdk.authDomain, VITE_FIREBASE_APP_ID: sdk.appId, VITE_FIREBASE_MESSAGING_SENDER_ID: sdk.messagingSenderId,
  VITE_FIREBASE_STORAGE_BUCKET: sdk.storageBucket, VITE_FIREBASE_FUNCTIONS_REGION: region,
  VITE_FIREBASE_FUNCTIONS_BASE_URL: `https://${region}-${project}.cloudfunctions.net`,
}
const server = {
  INTELLIGENTCANVAS_FUNCTIONS_MODE: 'production', INTELLIGENTCANVAS_PROJECT_ID: project,
  INTELLIGENTCANVAS_WEB_ORIGIN: origin, INTELLIGENTCANVAS_STORAGE_BUCKET: sdk.storageBucket,
  INTELLIGENTCANVAS_FUNCTIONS_REGION: region, INTELLIGENTCANVAS_SERVICE_ACCOUNT: `artwork-runtime@${project}.iam.gserviceaccount.com`,
}

test('the offline preflight requires an explicit separate test project and matching public configuration', () => {
  assert.deepEqual(checkFirebaseTestConfig(project, web, server, sdk), { project, bucket: sdk.storageBucket, region, webOrigin: origin })
  assert.throws(() => checkFirebaseTestConfig(firebaseEmulators.projectId, web, server, sdk), /별도의 Firebase 테스트 프로젝트/)
  assert.throws(() => checkFirebaseTestConfig('other-stage11-check', web, server, sdk), /프로젝트 ID/)
  assert.throws(() => checkFirebaseTestConfig(project, web, server, { ...sdk, apiKey: 'different-key' }), /apiKey/)
  assert.throws(() => checkFirebaseTestConfig(project, web, server), /Console/)
})

test('the offline preflight rejects mixed bucket, origin, region and emulator configuration', () => {
  const changes = [
    { INTELLIGENTCANVAS_STORAGE_BUCKET: `${project}.appspot.com` },
    { INTELLIGENTCANVAS_WEB_ORIGIN: 'https://different.example.invalid' },
    { INTELLIGENTCANVAS_FUNCTIONS_REGION: 'us-central1' },
  ]
  for (const change of changes) assert.throws(() => checkFirebaseTestConfig(project, web, { ...server, ...change }, sdk), /버킷, 리전, HTTPS 오리진/)
  assert.throws(() => checkFirebaseTestConfig(project, web, { ...server, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }, sdk), /Emulator/)
  assert.throws(() => checkFirebaseTestConfig(project, { ...web, VITE_FIREBASE_ENABLE_PRODUCTION: 'false' }, server, sdk), /잠겨/)
})

test('the deployment hook refuses missing and differently selected Firebase targets', () => {
  const script = fileURLToPath(new URL('./check-firebase-test-config.mjs', import.meta.url))
  for (const selected of ['', firebaseEmulators.projectId, 'other-stage11-check', project]) {
    const run = spawnSync(process.execPath, [script, '--project', project, '--assert-target'], {
      env: { ...process.env, GCLOUD_PROJECT: selected }, encoding: 'utf8',
    })
    if (selected === project) assert.equal(run.status, 0, run.stderr)
    else {
      assert.equal(run.status, 1)
      assert.match(run.stderr, /배포 대상/)
    }
  }
})

test('the prepared config pins Hosting, Rules, indexes and Functions to the checked test project', () => {
  const template = JSON.parse(readFileSync(new URL('../firebase.production.example.json', import.meta.url), 'utf8'))
  const webOrigin = `https://${project}.web.app`
  const checked = checkFirebaseTestConfig(project, { ...web, VITE_FIREBASE_APP_ORIGIN: webOrigin },
    { ...server, INTELLIGENTCANVAS_WEB_ORIGIN: webOrigin }, sdk)
  const config = prepareFirebaseTestDeployConfig(template, checked)
  assert.deepEqual(config.hosting.rewrites, [{ source: '**', destination: '/index.html' }])
  assert.equal(config.hosting.public, 'dist')
  assert.equal(config.hosting.site, project)
  assert.equal(config.storage[0].bucket, sdk.storageBucket)
  assert.equal(config.storage[0].rules, 'storage.production.rules')
  assert.equal(config.firestore.rules, 'firestore.production.rules')
  assert.equal(config.firestore.indexes, 'firestore.indexes.json')
  assert.equal(config.functions.source, 'functions')
  const expected = [`node scripts/check-firebase-test-config.mjs --project ${project} --assert-target`]
  for (const service of [config.hosting, config.storage[0], config.firestore, config.functions]) {
    assert.deepEqual(service.predeploy, expected)
  }
  assert.throws(() => prepareFirebaseTestDeployConfig(template, { ...checked, webOrigin: 'https://other-project.web.app' }), /기본 Hosting/)
  assert.throws(() => prepareFirebaseTestDeployConfig(template, { ...checked, webOrigin: `https://${project}.web.app:8080` }), /기본 Hosting/)
})
