// 기존 브라우저 대신 임시 일반 프로필과 격리 컨텍스트를 사용한다.
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright')
const port = '5196'
const base = `http://127.0.0.1:${port}`
const project = 'ai-drawing-a9177'
const runId = crypto.randomUUID()
const password = `Canvas-${runId}!`
const address = suffix => `auth-recovery-${runId}-${suffix}@example.test`
const refreshRoute = /securetoken\.googleapis\.com\/v1\/token/
const listenRoute = /Listen\/channel/
const users = new Set()
const unexpected = []
let browser, normal, server, passed = 0

async function check(name, run) {
  await run()
  console.log(`PASS ${name}`)
  passed++
}

async function preparePage(context, page) {
  await context.grantPermissions(['local-network-access'], { origin: base })
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1' && [port, '8081', '9099', '5001'].includes(url.port)) return route.continue()
    // Listen 장애 주입으로 WebChannel이 실행하는 연결 확인 이미지도 외부로 보내지 않는다.
    if (url.hostname === 'www.google.com' && url.pathname === '/images/cleardot.gif'
      && route.request().resourceType() === 'image') return route.abort()
    unexpected.push(`blocked ${route.request().resourceType()} to ${url.origin}${url.pathname}`)
    return route.abort()
  })
  page.on('pageerror', () => unexpected.push('uncaught browser error'))
  page.setDefaultTimeout(30000)
}

async function uidOf(page) {
  return page.evaluate(async () => {
    const { auth } = await import('/src/config/firebase.js')
    await auth.authStateReady()
    return auth.currentUser?.uid ?? null
  })
}

async function fillSignup(page, email) {
  for (const [name, value] of Object.entries({ username: '복원 검사', email, password, 'confirm-password': password })) {
    await page.locator(`#signup-${name}`).fill(value)
  }
  await page.getByRole('button', { name: '가입하기', exact: true }).click()
}

async function signup(page, email) {
  await page.goto(`${base}/signup`)
  await fillSignup(page, email)
  return finishSignup(page)
}

async function finishSignup(page) {
  await page.waitForURL(`${base}/`)
  const uid = await uidOf(page)
  assert.ok(uid)
  users.add(uid)
  return uid
}

async function submitLogin(page, email, value) {
  await page.goto(`${base}/login`)
  await page.locator('#login-email').fill(email)
  await page.locator('#login-password').fill(value)
  await page.getByRole('button', { name: '로그인', exact: true }).click()
}

async function fingerprint(page, uid) {
  return page.evaluate(async uid => {
    const { localDb } = await import('/src/db/localDb.js')
    const scope = [uid, 'auth-recovery-fixture']
    const [artwork, layer, queue, draft] = await Promise.all([
      localDb.artworks.get(scope), localDb.layerContents.get([...scope, 'ink']),
      localDb.syncQueue.get(scope), localDb.recoveryDrafts.get(scope.join(':')),
    ])
    const hash = async blob => new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())).join('.')
    return [artwork.title, await hash(layer.pngBlob), queue.requestId, await hash(queue.contents[0].pngBlob),
      draft.status, await hash(draft.layerContentsSnapshot[0].pngBlob)]
  }, uid)
}

try {
  server = await createServer({ cacheDir: '.firebase/vite-auth-recovery',
    optimizeDeps: { include: ['firebase/auth', 'firebase/firestore', 'firebase/functions'] },
    server: { host: '127.0.0.1', port: Number(port), strictPort: true, ws: false }, logLevel: 'error' })
  await server.listen()
  const browserOptions = { channel: process.env.TEST_BROWSER_CHANNEL || 'msedge', headless: true }
  normal = await chromium.launchPersistentContext('', browserOptions)
  const page = normal.pages()[0] ?? await normal.newPage()
  await preparePage(normal, page)

  await check('regular profile rejects a persisted invalid refresh token and preserves local work', async () => {
    const oldUid = await signup(page, address('old'))
    const editedAuthKey = await page.evaluate(async uid => {
      const { localDb } = await import('/src/db/localDb.js')
      const artworkId = 'auth-recovery-fixture'
      const canvas = new OffscreenCanvas(1, 1)
      canvas.getContext('2d').fillRect(0, 0, 1, 1)
      const pngBlob = await canvas.convertToBlob()
      const layer = { uid, artworkId, layerId: 'ink', pngBlob }
      await localDb.artworks.add({ uid, artworkId, title: '남은 로컬 작품', state: 'active' })
      await localDb.layerContents.add(layer)
      await localDb.syncQueue.add({ uid, artworkId, requestId: 'preserve-this-job', contents: [layer] })
      await localDb.recoveryDrafts.add({ uid, artworkId, draftId: [uid, artworkId].join(':'),
        status: 'preserved', layerContentsSnapshot: [layer] })
      const key = Object.keys(localStorage).find(key => key.startsWith('firebase:authUser:') && key.endsWith(':[DEFAULT]'))
      const stored = JSON.parse(localStorage.getItem(key))
      stored.stsTokenManager.expirationTime = 0
      stored.stsTokenManager.refreshToken = `invalid-test-token-${crypto.randomUUID()}`
      localStorage.setItem(key, JSON.stringify(stored))
      return key
    }, oldUid)
    const before = await fingerprint(page, oldUid)
    let firestoreRequests = 0
    const countFirestore = request => { if (new URL(request.url()).port === '8081') firestoreRequests++ }
    page.on('request', countFirestore)
    const rejection = page.waitForResponse(response => refreshRoute.test(response.url()) && response.status() === 400)
    await page.goto(`${base}/signup`)
    const response = await rejection
    assert.equal((await response.json()).error.message, 'INVALID_REFRESH_TOKEN')
    await page.waitForFunction(() => !document.querySelector('form').matches('[aria-busy="true"]'))
    assert.equal(await uidOf(page), null)
    assert.equal(await page.evaluate(key => localStorage.getItem(key) === null, editedAuthKey), true)
    assert.equal(firestoreRequests, 0)
    page.off('request', countFirestore)
    assert.deepEqual(await fingerprint(page, oldUid), before)
    await fillSignup(page, address('new'))
    const uid = await finishSignup(page)
    assert.notEqual(uid, oldUid)
    assert.deepEqual(await fingerprint(page, oldUid), before)
    await submitLogin(page, address('new'), 'wrong-password')
    await page.getByRole('alert').filter({ hasText: '이메일 또는 비밀번호가 올바르지 않습니다.' }).waitFor()
    assert.equal(await page.getByRole('button', { name: '로그인', exact: true }).isEnabled(), true)
    await submitLogin(page, address('new'), password)
    await page.waitForURL(`${base}/`)
    assert.equal(await uidOf(page), uid)
  })

  await check('a transient Auth connection error preserves an existing valid local session', async () => {
    const uid = await uidOf(page)
    let rejected = 0
    await page.route(refreshRoute, route => { rejected++; return route.abort() })
    try {
      await page.goto(`${base}/login`)
      await page.waitForFunction(() => !document.querySelector('form').matches('[aria-busy="true"]'))
      assert.ok(rejected > 0)
      assert.equal(await uidOf(page), uid)
      assert.equal(await page.getByRole('button', { name: '로그인', exact: true }).isEnabled(), true)
    } finally { await page.unroute(refreshRoute) }
  })

  await check('refresh rejection during same-account signup releases the form and signs out', async () => {
    await page.goto(`${base}/signup`)
    assert.equal(await page.getByRole('button', { name: '가입하기', exact: true }).isEnabled(), true)
    const confirmedUid = await uidOf(page)
    await page.evaluate(async () => {
      const { auth } = await import('/src/config/firebase.js')
      const { registerPendingCanvasEditor } = await import('/src/services/pendingCanvasChanges.js')
      window.flushUsers = []
      window.removeFixtureEditor = registerPendingCanvasEditor({
        lock: () => () => {},
        flush: () => { window.flushUsers.push(auth.currentUser?.uid ?? null) },
      })
    })
    await page.route(refreshRoute, route => route.fulfill({ status: 400, json: {
      error: { code: 400, message: 'INVALID_REFRESH_TOKEN' },
    } }))
    try {
      await fillSignup(page, address('new'))
      await page.getByRole('alert').filter({ hasText: '이전 로그인 세션이 만료되었거나 무효화되었습니다.' }).waitFor()
      assert.equal(await uidOf(page), null)
      assert.equal(await page.getByRole('button', { name: '가입하기', exact: true }).isEnabled(), true)
      const flushUsers = await page.evaluate(() => window.flushUsers)
      assert.ok(flushUsers.length >= 2 && flushUsers.every(uid => uid === confirmedUid))
    } finally {
      await page.evaluate(() => window.removeFixtureEditor())
      await page.unroute(refreshRoute)
    }
  })

  browser = await chromium.launch(browserOptions)
  const isolated = await browser.newContext()
  const privatePage = await isolated.newPage()
  await preparePage(isolated, privatePage)
  await check('incognito-style context signs up, rejects duplicate signup and logs in', async () => {
    const uid = await signup(privatePage, address('private'))
    await privatePage.evaluate(async () => (await import('/src/services/authService.js')).logoutUser())
    await privatePage.goto(`${base}/signup`)
    await fillSignup(privatePage, address('private'))
    await privatePage.getByRole('alert').filter({ hasText: '이미 가입된 이메일입니다.' }).waitFor()
    assert.equal(await privatePage.getByRole('button', { name: '가입하기', exact: true }).isEnabled(), true)
    await submitLogin(privatePage, address('private'), password)
    await privatePage.waitForURL(`${base}/`)
    assert.equal(await uidOf(privatePage), uid)
  })

  await check('stalled Firestore read releases signup and retries the profile under the same UID', async () => {
    await privatePage.goto(`${base}/signup`)
    await privatePage.route(listenRoute, route => route.abort())
    try {
      await fillSignup(privatePage, address('profile'))
      const retry = privatePage.getByRole('button', { name: '프로필 저장 다시 시도', exact: true })
      await retry.waitFor()
      const uid = await uidOf(privatePage)
      assert.ok(uid)
      users.add(uid)
      assert.equal(await retry.isEnabled(), true)
      await privatePage.unroute(listenRoute)
      await retry.click()
      await privatePage.waitForURL(`${base}/`)
      assert.equal(await uidOf(privatePage), uid)
    } finally { await privatePage.unroute(listenRoute) }
  })
  assert.deepEqual(unexpected, [])
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await normal?.close()
  await browser?.close()
  await server?.close()
  for (const uid of users) {
    const authUrl = `http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/${project}/accounts:delete`
    const profile = `http://127.0.0.1:8081/v1/projects/${project}/databases/(default)/documents/users/${encodeURIComponent(uid)}`
    const headers = { Authorization: 'Bearer owner' }
    try {
      const removedProfile = await fetch(profile, { method: 'DELETE', headers })
      assert.ok(removedProfile.ok || removedProfile.status === 404)
      const removedUser = await fetch(authUrl, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ localId: uid }) })
      assert.ok(removedUser.ok)
    } catch (error) {
      console.error('Test account cleanup failed:', error.message)
      process.exitCode = 1
    }
  }
  console.log(`Auth recovery checks passed: ${passed}`)
}
