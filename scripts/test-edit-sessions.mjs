import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright')
const base = 'http://127.0.0.1:5191'
const project = 'ai-drawing-a9177'
const docs = `http://127.0.0.1:8081/v1/projects/${project}/databases/(default)/documents`
const owner = { Authorization: 'Bearer owner' }
const primary = crypto.randomUUID()
const separate = crypto.randomUUID()
const race = crypto.randomUUID()
const password = `${primary}-test`
const email = `session-${primary}@example.test`
const users = []
const fixtures = []
let server, browser, passed = 0

async function check(label, action) {
  await action()
  passed++
  console.log(`PASS ${label}`)
}
async function browserPage() {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } })
  await context.grantPermissions(['local-network-access'], { origin: base })
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    return url.hostname === '127.0.0.1' && ['5191', '9099', '8081', '5001'].includes(url.port)
      ? route.continue() : route.abort()
  })
  const page = await context.newPage()
  await page.goto(base)
  return page
}
async function account(page, email, signUp) {
  const uid = await page.evaluate(async ({ email, password, signUp }) => {
    const auth = await import('/src/services/authService.js')
    if (signUp) return (await auth.registerUser({ email, password, username: '세션 검증' })).user.uid
    return (await auth.loginUser({ email, password })).uid
  }, { email, password, signUp })
  if (signUp) users.push(uid)
  return uid
}
async function call(page, name, artworkId, input = {}) {
  const result = await page.evaluate(async ({ name, artworkId, input }) => {
    try {
      const { callEditSession } = await import('/src/services/editSessionService.js')
      return { value: await callEditSession(name, artworkId, input) }
    } catch (error) { return { code: error.code || 'unexpected', message: error.code ? null : error.message } }
  }, { name, artworkId, input })
  if (result.code) throw Object.assign(new Error(result.message || result.code), { code: result.code })
  return result.value
}
async function seed(uid, id) {
  const path = `users/${uid}/artworks/${id}`
  fixtures.push(path)
  const response = await fetch(`${docs}/${path}`, { method: 'PATCH',
    headers: { ...owner, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { ownerUid: { stringValue: uid }, state: { stringValue: 'active' } } }),
  })
  assert.equal(response.status, 200)
}
async function seedLocal(page, uid, artworkId) {
  await page.evaluate(async ({ uid, artworkId }) => {
    const { localDb } = await import('/src/db/localDb.js')
    await localDb.artworks.add({ uid, artworkId, title: '세션 검증', titleNormalized: '세션 검증',
      state: 'active', width: 800, height: 800, backgroundColor: '#ffffff', createdAt: 1, updatedAt: 1, schemaVersion: 1 })
  }, { uid, artworkId })
}
async function go(page, id) {
  await page.goto(`${base}/drawing/${id}`)
  await page.locator('.drawcanvas[data-ready="true"]').waitFor()
}
async function readonly(page) {
  await page.getByText('다른 기기에서 편집 중이므로 읽기 전용입니다.').waitFor()
  assert.equal(await page.locator('.drawcanvas').getAttribute('data-read-only'), 'true')
}
async function stroke(page) {
  const box = await page.locator('.drawcanvas').boundingBox()
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.35)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.35, { steps: 8 })
  await page.mouse.up()
}
async function opaque(page) {
  return page.locator('.drawcanvas').evaluate(canvas => canvas.getContext('2d')
    .getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0))
}

try {
  server = await createServer({
    cacheDir: '.firebase/vite-stage5b',
    optimizeDeps: { include: ['firebase/firestore', 'firebase/functions', 'firebase/storage', 'firebase/auth'] },
    server: { host: '127.0.0.1', port: 5191, strictPort: true }, logLevel: 'error',
  })
  await server.listen()
  browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'msedge', headless: true })
  const a = await browserPage()
  const b = await browserPage()
  const c = await browserPage()
  await check('signed-out callable rejected', async () => {
    await assert.rejects(call(c, 'getEditSessionStatus', primary), { code: 'functions/unauthenticated' })
  })
  const uid = await account(a, email, true)
  assert.equal(await account(b, email, false), uid)
  await account(c, `different-${email}`, true)
  for (const id of [primary, separate, race]) await seed(uid, id)
  await seedLocal(a, uid, primary)
  await seedLocal(b, uid, primary)

  await check('a acquires and b opens in read-only without secrets', async () => {
    await go(a, primary)
    await a.getByRole('button', { name: '편집 세션 받기' }).click()
    await a.getByRole('button', { name: '수정 시작' }).waitFor()
    await go(b, primary)
    await readonly(b)
    assert.deepEqual(await call(b, 'getEditSessionStatus', primary), { status: 'occupied' })
    await assert.rejects(call(b, 'acquireEditSession', primary, { deviceId: 'other-device' }), { code: 'functions/already-exists' })
  })
  await check('read-only b cannot draw, mutate layers or write through repositories', async () => {
    await stroke(b)
    assert.equal(await opaque(b), false)
    await b.getByRole('button', { name: '레이어 패널 열기' }).click()
    assert.equal(await b.getByRole('button', { name: '레이어 추가' }).isDisabled(), true)
    assert.equal(await b.getByRole('button', { name: '이름 변경' }).isDisabled(), true)
    assert.equal(await b.locator('.layer-eye').isDisabled(), true)
    assert.equal(await b.getByLabel('불투명도').isDisabled(), true)
    assert.equal(await b.locator('.layer-select').isEnabled(), true)
    const before = await b.locator('.drawcanvas').boundingBox()
    await b.mouse.move(500, 330)
    await b.mouse.wheel(0, 250)
    await b.waitForFunction(width => document.querySelector('.drawcanvas').getBoundingClientRect().width !== width, before.width)
    const checks = await b.evaluate(async ({ uid, artworkId }) => {
      const { renameArtwork, deleteArtwork } = await import('/src/repositories/artworkRepository.js')
      const { saveLayerChanges } = await import('/src/repositories/layerRepository.js')
      const { localDb } = await import('/src/db/localDb.js')
      const codes = []
      for (const change of [
        () => renameArtwork(uid, artworkId, 'blocked'),
        () => deleteArtwork(uid, artworkId),
        () => saveLayerChanges(uid, artworkId, { previousIds: [], contents: [] }),
      ]) {
        try { await change(); codes.push('wrote') } catch (error) { codes.push(error.code) }
      }
      return { codes, layerCount: await localDb.layers.count(), updatedAt: (await localDb.artworks.get([uid, artworkId])).updatedAt }
    }, { uid, artworkId: primary })
    assert.deepEqual(checks, { codes: Array(3).fill('artwork/read-only'), layerCount: 0, updatedAt: 1 })
  })
  await check('unreachable session API keeps a registered artwork read-only', async () => {
    const pattern = '**/getEditSessionStatus'
    await b.route(pattern, route => route.abort())
    try {
      await go(b, primary)
      await b.getByText(/편집 권한을 확인하지 못해 읽기 전용/).waitFor()
      assert.equal(await b.locator('.drawcanvas').getAttribute('data-read-only'), 'true')
      await stroke(b)
      assert.equal(await opaque(b), false)
    } finally { await b.unroute(pattern) }
    await b.getByRole('button', { name: '편집 권한 다시 확인' }).click()
    await readonly(b)
  })
  await check('separate artworks acquire independently, and competing acquisitions have one winner', async () => {
    const secondProof = await call(b, 'acquireEditSession', separate, { deviceId: 'b' })
    assert.equal((await call(b, 'getEditSessionStatus', separate, { proof: secondProof })).status, 'held')
    await call(b, 'releaseEditSession', separate, { proof: secondProof })
    const attempts = await Promise.allSettled([
      call(a, 'acquireEditSession', race, { deviceId: 'a' }),
      call(b, 'acquireEditSession', race, { deviceId: 'b' }),
    ])
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'functions/already-exists')
    const proof = attempts.find(result => result.status === 'fulfilled').value
    await call(a, 'releaseEditSession', race, { proof })
    const next = await call(b, 'acquireEditSession', race, { deviceId: 'b' })
    assert.equal(next.generation, proof.generation + 1)
    await assert.rejects(call(a, 'releaseEditSession', race, { proof }), { code: 'functions/permission-denied' })
  })
  const key = `intelligentcanvas:editing:${uid}:${primary}`
  const proof = await a.evaluate(key => JSON.parse(sessionStorage.getItem(key)), key)
  await check('other uid, forged credential and raw session reads are denied', async () => {
    await assert.rejects(call(c, 'acquireEditSession', primary, { deviceId: 'c' }), { code: 'functions/not-found' })
    await assert.rejects(call(c, 'releaseEditSession', primary, { proof }), { code: 'functions/not-found' })
    const forged = { ...proof, token: 'a'.repeat(43) }
    assert.deepEqual(await call(b, 'getEditSessionStatus', primary, { proof: forged }), { status: 'occupied' })
    await assert.rejects(call(b, 'releaseEditSession', primary, { proof: forged }), { code: 'functions/permission-denied' })
    const authToken = await a.evaluate(async () => (await import('/src/config/firebase.js')).auth.currentUser.getIdToken())
    const path = `${docs}/users/${uid}/artworks/${primary}/editSession/current`
    const headers = { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' }
    assert.equal((await fetch(path, { headers })).status, 403)
    assert.equal((await fetch(path, { method: 'PATCH', headers, body: '{"fields":{"status":{"stringValue":"released"}}}' })).status, 403)
    const record = await (await fetch(path, { headers: owner })).json()
    assert.equal(record.fields.token, undefined)
    assert.match(record.fields.tokenHash.stringValue, /^[a-f0-9]{64}$/)
  })
  await check('reload revalidates a, copied tab stays read-only, offline never releases', async () => {
    await a.reload()
    await a.getByRole('button', { name: '수정 시작' }).waitFor()
    const tab = await a.context().newPage()
    await tab.addInitScript(({ key, proof }) => sessionStorage.setItem(key, JSON.stringify(proof)), { key, proof })
    await go(tab, primary)
    await readonly(tab)
    assert.equal(await tab.evaluate(key => sessionStorage.getItem(key), key), null)
    await tab.close()
    await a.context().setOffline(true)
    assert.deepEqual(await call(b, 'getEditSessionStatus', primary), { status: 'occupied' })
    await a.context().setOffline(false)
    await a.getByRole('button', { name: '변경 없이 세션 반납' }).click()
    await a.getByRole('button', { name: '편집 세션 받기' }).waitFor()
    await b.getByRole('button', { name: '편집 권한 다시 확인' }).click()
    await b.getByRole('button', { name: '편집 세션 받기' }).click()
    await b.getByRole('button', { name: '수정 시작' }).waitFor()
  })
  await check('verified owner edits offline, reserves local changes, and cannot release before sync', async () => {
    await b.getByRole('button', { name: '수정 시작' }).click()
    await b.locator('.drawcanvas[data-read-only="false"]').waitFor()
    const current = await b.evaluate(key => JSON.parse(sessionStorage.getItem(key)), key)
    await b.context().setOffline(true)
    await stroke(b)
    await b.getByText('이 브라우저에 저장됨').waitFor()
    assert.equal(await opaque(b), true)
    await b.getByRole('button', { name: '레이어 패널 열기' }).click()
    b.once('dialog', dialog => dialog.accept('이어 그린 레이어'))
    await b.getByRole('button', { name: '이름 변경' }).click()
    await b.getByText('이어 그린 레이어', { exact: true }).waitFor()
    await b.getByText('이 브라우저에 저장됨').waitFor()
    assert.deepEqual(await call(a, 'getEditSessionStatus', primary), { status: 'occupied' })
    // 동일 UID의 검증된 현재 자격 증명도 서버 확인 없이 반납할 수 없다.
    await assert.rejects(call(a, 'releaseEditSession', primary, { proof: current }), { code: 'functions/failed-precondition' })
    await b.context().setOffline(false)
    await b.reload()
    await b.locator('.drawcanvas[data-read-only="false"]').waitFor()
    assert.equal(await opaque(b), true)
    await b.getByRole('button', { name: '레이어 패널 열기' }).click()
    await b.getByText('이어 그린 레이어', { exact: true }).waitFor()
  })
  await check('closing holder tab does not release the server session', async () => {
    await b.close()
    assert.deepEqual(await call(a, 'getEditSessionStatus', primary), { status: 'occupied' })
  })
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await browser?.close()
  await server?.close()
  async function clean(url, init) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) })
      if (!response.ok && response.status !== 404) throw Error(`Cleanup HTTP ${response.status}`)
    } catch (error) { console.error(error.message); process.exitCode = 1 }
  }
  for (const path of fixtures) {
    await clean(`${docs}/${path}/editSession/current`, { method: 'DELETE', headers: owner })
    await clean(`${docs}/${path}`, { method: 'DELETE', headers: owner })
  }
  for (const uid of users) {
    await clean(`${docs}/users/${uid}`, { method: 'DELETE', headers: owner })
    await clean(`http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/${project}/accounts:delete`,
      { method: 'POST', headers: { ...owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ localId: uid }) })
  }
  console.log(`Edit session checks passed: ${passed}`)
}
