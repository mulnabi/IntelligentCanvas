import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const origin = 'https://stage11.example.invalid'
const primary = 'offline-stage11-first'
const secondary = 'offline-stage11-second'
const apiKey = 'stage11-public-test-key'
const privateValues = { VITE_FIREBASE_PRIVATE_KEY: 'stage11-private-marker-2f97', VITE_MISC_SECRET: 'stage11-unrelated-marker-bf78' }
const root = fileURLToPath(new URL('../', import.meta.url))

async function buildFixture(project) {
  const variables = {
    ...privateValues,
    VITE_FIREBASE_MODE: 'production', VITE_USE_FIREBASE_EMULATORS: 'false', VITE_FIREBASE_ENABLE_PRODUCTION: 'true',
    VITE_FIREBASE_PROJECT_ID: project, VITE_FIREBASE_APP_ORIGIN: origin, VITE_FIREBASE_API_KEY: apiKey,
    VITE_FIREBASE_AUTH_DOMAIN: `${project}.firebaseapp.com`, VITE_FIREBASE_APP_ID: '1:123456:web:aabb1234',
    VITE_FIREBASE_MESSAGING_SENDER_ID: '123456', VITE_FIREBASE_STORAGE_BUCKET: `${project}.firebasestorage.app`,
    VITE_FIREBASE_FUNCTIONS_REGION: 'asia-northeast3',
    VITE_FIREBASE_FUNCTIONS_BASE_URL: `https://asia-northeast3-${project}.cloudfunctions.net`,
  }
  const original = new Map(Object.keys(variables).map(key => [key, process.env[key]]))
  Object.assign(process.env, variables)
  try {
    const result = await build({
      root, configFile: false, envDir: '.firebase/stage11-browser-fixture-env', logLevel: 'error',
      build: { write: false, rolldownOptions: { input: 'virtual:firebase-stage11', output: { entryFileNames: 'app.js' } } },
      plugins: [{
        name: 'stage11-fixture',
        resolveId: id => id === 'virtual:firebase-stage11' ? '\0' + id : null,
        load: id => id === '\0virtual:firebase-stage11' ? `
          import Dexie from 'dexie'
          import { app, auth, db } from '/src/config/firebase.js'
          import { functions, storage, artworkFunctionUrl } from '/src/config/firebaseServices.js'
          import { localDb } from '/src/db/localDb.js'
          import { getDeviceId, readTabGrant, storeTabGrant } from '/src/services/editSessionService.js'
          globalThis.stage11 = { Dexie, app, auth, db, functions, storage, artworkFunctionUrl, localDb, getDeviceId, readTabGrant, storeTabGrant }
        ` : null,
      }],
    })
    assert.ok(!Array.isArray(result) && result.output)
    const files = new Map(result.output.map(file => [`/${file.fileName}`, file.type === 'chunk' ? file.code : file.source]))
    for (const contents of files.values()) {
      for (const value of Object.values(privateValues)) assert.ok(!String(contents).includes(value))
    }
    assert.ok(String(files.get('/app.js')).includes(apiKey))
    return files
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('production browser bundles keep Auth, queued work and drafts separate on the same HTTPS origin', async t => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
    ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright')
  const first = await buildFixture(primary)
  const second = await buildFixture(secondary)
  const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'msedge', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  let bundle = first
  const requests = []
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === origin && url.pathname === '/') return route.fulfill({
      contentType: 'text/html', body: '<!doctype html><script type="module" src="/app.js"></script>',
    })
    const contents = url.origin === origin ? bundle.get(url.pathname) : null
    if (contents) return route.fulfill({ contentType: 'text/javascript', body: contents })
    requests.push(url.origin)
    return route.abort()
  })
  await page.goto(origin)
  await page.waitForFunction(() => Boolean(window.stage11))
  const summarize = async () => page.evaluate(async () => {
    const { app, auth, db, functions, storage, artworkFunctionUrl, localDb, getDeviceId, readTabGrant } = window.stage11
    await auth.authStateReady()
    return {
      app: app.name, services: [auth, db, functions, storage].map(service => service.app.name),
      authEmulator: auth.emulatorConfig, functionsEmulator: functions.emulatorOrigin,
      firestoreHost: db._getSettings().host, storageHost: storage.host, documentDatabase: localDb.name,
      queue: await localDb.syncQueue.count(), drafts: await localDb.recoveryDrafts.count(),
      grant: readTabGrant('shared-uid', 'shared-art'), device: getDeviceId(), user: auth.currentUser,
      pngEndpoint: artworkFunctionUrl('downloadArtworkPng').href,
    }
  })
  const initial = await summarize()
  const name = `intelligentcanvas-cloud-${primary}`
  assert.equal(initial.app, name)
  assert.deepEqual(initial.services, [name, name, name, name])
  assert.equal(initial.authEmulator, null)
  assert.equal(initial.functionsEmulator, null)
  assert.equal(initial.firestoreHost, 'firestore.googleapis.com')
  assert.equal(initial.storageHost, 'firebasestorage.googleapis.com')
  assert.equal(initial.pngEndpoint, `https://asia-northeast3-${primary}.cloudfunctions.net/downloadArtworkPng`)
  assert.equal(initial.documentDatabase, `IntelligentCanvasLocal-cloud-${primary}`)
  assert.deepEqual([initial.queue, initial.drafts], [0, 0])

  const proof = { sessionId: 'fixture-session', deviceId: 'fixture-device', generation: 1, token: 'z'.repeat(43) }
  await page.evaluate(async ({ apiKey, proof }) => {
    const { Dexie, localDb, storeTabGrant } = window.stage11
    const legacy = new Dexie('IntelligentCanvasLocal')
    legacy.version(1).stores({ syncQueue: '[uid+artworkId]', recoveryDrafts: 'draftId' })
    const artwork = { uid: 'shared-uid', artworkId: 'shared-art' }
    await legacy.syncQueue.put({ ...artwork, requestId: 'emulator-request' })
    await legacy.recoveryDrafts.put({ ...artwork, draftId: 'emulator-draft' })
    legacy.close()
    await localDb.syncQueue.put({ ...artwork, requestId: 'cloud-first-request' })
    await localDb.recoveryDrafts.put({ ...artwork, draftId: 'cloud-first-draft' })
    sessionStorage.setItem('intelligentcanvas:editing:shared-uid:shared-art', 'emulator-grant')
    localStorage.setItem(`firebase:authUser:${apiKey}:[DEFAULT]`, 'emulator-auth')
    storeTabGrant(artwork.uid, artwork.artworkId, proof)
  }, { apiKey, proof })

  bundle = second
  await page.reload()
  await page.waitForFunction(() => Boolean(window.stage11))
  const switched = await summarize()
  assert.equal(switched.app, `intelligentcanvas-cloud-${secondary}`)
  assert.equal(switched.documentDatabase, `IntelligentCanvasLocal-cloud-${secondary}`)
  assert.deepEqual([switched.queue, switched.drafts, switched.grant, switched.user], [0, 0, null, null])
  assert.notEqual(switched.device, initial.device)

  bundle = first
  await page.reload()
  await page.waitForFunction(() => Boolean(window.stage11))
  const restored = await summarize()
  assert.deepEqual([restored.queue, restored.drafts, restored.grant, restored.device], [1, 1, proof, initial.device])
  const preserved = await page.evaluate(async apiKey => {
    const legacy = new window.stage11.Dexie('IntelligentCanvasLocal')
    await legacy.open()
    try {
      return [(await legacy.table('syncQueue').toArray())[0]?.requestId, (await legacy.table('recoveryDrafts').toArray())[0]?.draftId,
        sessionStorage.getItem('intelligentcanvas:editing:shared-uid:shared-art'),
        localStorage.getItem(`firebase:authUser:${apiKey}:[DEFAULT]`)]
    } finally { legacy.close() }
  }, apiKey)
  assert.deepEqual(preserved, ['emulator-request', 'emulator-draft', 'emulator-grant', 'emulator-auth'])
  assert.deepEqual(requests, [])
})
