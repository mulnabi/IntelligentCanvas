import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright')
const base = 'http://127.0.0.1:5192'
const project = 'ai-drawing-a9177'
const bucket = 'intelligentcanvas-stage5a-local.invalid'
const docs = `http://127.0.0.1:8081/v1/projects/${project}/databases/(default)/documents`
const gcs = `http://127.0.0.1:9199/storage/v1/b/${bucket}/o`
const firebaseStorage = `http://127.0.0.1:9199/v0/b/${bucket}/o`
const admin = { Authorization: 'Bearer owner' }
const runId = crypto.randomUUID()
const email = `sync-${runId}@example.test`
const password = `Sync-${runId}!`
const users = []
const blocked = []
let server, browser, uid, id, passed = 0

async function check(label, action) { await action(); passed++; console.log(`PASS ${label}`) }
async function tab() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.grantPermissions(['local-network-access'], { origin: base })
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1' && ['5192', '9099', '8081', '5001'].includes(url.port)) return route.continue()
    blocked.push(url.origin)
    return route.abort()
  })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  await page.goto(base)
  return page
}
async function account(page, email, create) {
  const user = await page.evaluate(async ({ email, password, create }) => {
    const { registerUser, loginUser } = await import('/src/services/authService.js')
    return create ? (await registerUser({ email, password, username: '5-C 검증' })).user.uid : (await loginUser({ email, password })).uid
  }, { email, password, create })
  if (create) users.push(user)
  return user
}
async function currentUid(page) {
  return page.evaluate(async () => {
    const { auth } = await import('/src/config/firebase.js')
    await auth.authStateReady()
    return auth.currentUser?.uid ?? null
  })
}
async function call(page, name, input = {}) {
  const outcome = await page.evaluate(async ({ name, input, id }) => {
    try {
      if (name === 'listServerArtworks') {
        const { listServerArtworks } = await import('/src/services/artworkSyncService.js')
        const { auth } = await import('/src/config/firebase.js')
        return { result: (await listServerArtworks(auth.currentUser.uid, input)).rows }
      }
      const { callEditSession } = await import('/src/services/editSessionService.js')
      return { result: await callEditSession(name, id, input) }
    } catch (err) { return { code: err.code, message: err.message } }
  }, { name, input, id })
  if ('message' in outcome) throw Object.assign(new Error(outcome.message), { code: outcome.code })
  return outcome.result
}
async function local(page) {
  return page.evaluate(async key => {
    const { localDb } = await import('/src/db/localDb.js')
    const state = await localDb.artworkSync.get(key)
    const job = await localDb.syncQueue.get(key)
    const artwork = await localDb.artworks.get(key)
    return { state, job: job && { requestId: job.requestId, localVersion: job.localVersion }, title: artwork?.title }
  }, [uid, id])
}
async function waitForLocalReceipt(page, version) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const { state, job } = await local(page)
    if (!job && state?.receipt?.serverVersion === version && state.localVersion === state.ackLocalVersion) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`No confirmed local receipt for v${version}`)
}
async function proof(page) {
  return page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), `intelligentcanvas:editing:${uid}:${id}`)
}
async function draw(page, row) {
  const box = await page.locator('.drawcanvas').boundingBox()
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * row)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.58, box.y + box.height * row, { steps: 12 })
  await page.mouse.up()
  await page.getByText('이 브라우저에 저장됨', { exact: true }).waitFor()
}
async function signatures(page) {
  return page.evaluate(async ([uid, id]) => {
    const { localDb } = await import('/src/db/localDb.js')
    const layers = await localDb.layers.where('[uid+artworkId+sortOrder]').between([uid, id, 0], [uid, id, 64], true, true).toArray()
    const hash = async canvas => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))).join('.')
    }
    const originals = []
    for (const row of layers) {
      const blob = (await localDb.layerContents.get([uid, id, row.layerId]))?.pngBlob
      let pixels = null
      if (blob) {
        const bitmap = await createImageBitmap(blob)
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        canvas.getContext('2d').drawImage(bitmap, 0, 0)
        bitmap.close()
        pixels = await hash(canvas)
      }
      originals.push([row.layerId, row.name, row.visible, row.opacity, row.sortOrder, pixels])
    }
    return { originals, composite: await hash(document.querySelector('.drawcanvas')) }
  }, [uid, id])
}
async function remoteDocument() {
  const response = await fetch(`${docs}/users/${uid}/artworks/${id}`, { headers: admin })
  return response.ok ? (await response.json()).fields : null
}

try {
  server = await createServer({
    cacheDir: '.firebase/vite-stage5c',
    optimizeDeps: { include: ['firebase/firestore', 'firebase/functions', 'firebase/storage', 'firebase/auth'] },
    server: { host: '127.0.0.1', port: 5192, strictPort: true }, logLevel: 'error',
  })
  await server.listen()
  browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'msedge', headless: true })
  const a = await tab()
  const b = await tab()
  const c = await tab()
  await check('Dexie v3 artwork, layer settings and PNG bytes survive the v5 upgrade', async () => {
    const result = await c.evaluate(async () => {
      const uid = 'isolated-upgrade-fixture'
      const artworkId = 'v3-artwork'
      const layerId = 'v3-layer'
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 8
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#cc2244'
      ctx.fillRect(0, 0, 8, 8)
      const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('IntelligentCanvasLocal', 30)
        req.onupgradeneeded = () => {
          const db = req.result
          const artworks = db.createObjectStore('artworks', { keyPath: ['uid', 'artworkId'] })
          artworks.createIndex('[uid+state+updatedAt]', ['uid', 'state', 'updatedAt'])
          artworks.createIndex('[uid+state+createdAt]', ['uid', 'state', 'createdAt'])
          artworks.add({ uid, artworkId, state: 'active', title: 'v3 원본', width: 8, height: 8, createdAt: 12, updatedAt: 12 })
          db.createObjectStore('canvasContents', { keyPath: ['uid', 'artworkId'] })
          const layers = db.createObjectStore('layers', { keyPath: ['uid', 'artworkId', 'layerId'] })
          layers.createIndex('[uid+artworkId+sortOrder]', ['uid', 'artworkId', 'sortOrder'])
          layers.add({ uid, artworkId, layerId, name: 'v3 숨긴 레이어', sortOrder: 0, opacity: 0.5, visible: false })
          db.createObjectStore('layerContents', { keyPath: ['uid', 'artworkId', 'layerId'] })
            .add({ uid, artworkId, layerId, pngBlob, width: 8, height: 8 })
        }
        req.onsuccess = () => { req.result.close(); resolve() }
        req.onerror = () => reject(req.error)
      })
      const { localDb } = await import('/src/db/localDb.js')
      const row = await localDb.artworks.get([uid, artworkId])
      const layer = await localDb.layers.get([uid, artworkId, layerId])
      const stored = await localDb.layerContents.get([uid, artworkId, layerId])
      const original = new Uint8Array(await pngBlob.arrayBuffer())
      const bytes = new Uint8Array(await stored.pngBlob.arrayBuffer())
      return { version: localDb.verno, title: row.title, name: layer.name, opacity: layer.opacity, visible: layer.visible,
        exactPng: bytes.length === original.length && bytes.every((value, i) => value === original[i]),
        queued: await localDb.syncQueue.count() }
    })
    assert.deepEqual(result, { version: 5, title: 'v3 원본', name: 'v3 숨긴 레이어', opacity: 0.5, visible: false, exactPng: true, queued: 0 })
  })
  await check('signup, profile, logout, login and artwork creation share the browser flow', async () => {
    await a.goto(`${base}/signup`)
    for (const [field, value] of Object.entries({ username: '5-C 검증', email, password, 'confirm-password': password })) {
      await a.locator(`#signup-${field}`).fill(value)
    }
    await a.locator('button[type=submit]').click()
    await a.waitForURL(`${base}/`)
    uid = await currentUid(a)
    assert.ok(uid)
    users.push(uid)
    const profile = await a.evaluate(async uid => (await import('/src/services/userService.js')).getUserProfile(uid), uid)
    assert.equal(profile.uid, uid)
    assert.equal(profile.nickname, '5-C 검증')
    await a.evaluate(async () => (await import('/src/services/authService.js')).logoutUser())
    assert.equal(await currentUid(a), null)
    for (const page of [a, b]) {
      await page.goto(`${base}/login`)
      await page.locator('#login-email').fill(email)
      await page.locator('#login-password').fill(password)
      await page.locator('button[type=submit]').click()
      await page.waitForURL(`${base}/`)
      assert.equal(await currentUid(page), uid)
    }
    await a.getByRole('button', { name: '+ 새 작품', exact: true }).click()
    await a.locator('#new-artwork-title').fill('동기화 검증')
    await a.getByRole('button', { name: '확인', exact: true }).click()
    await a.getByRole('button', { name: '동기화 검증 열기', exact: true }).click()
    await a.waitForURL(/\/drawing\/[^/]+$/)
    id = new URL(a.url()).pathname.split('/').at(-1)
  })
  await account(c, `other-${email}`, true)
  await a.locator('.drawcanvas[data-ready="true"]').waitFor()
  await draw(a, 0.27)
  await a.getByRole('button', { name: '레이어 패널 열기' }).click()
  await a.getByRole('button', { name: '레이어 추가' }).click()
  await draw(a, 0.40)
  a.once('dialog', dialog => dialog.accept('두 번째 원본'))
  await a.getByRole('button', { name: '이름 변경' }).click()
  await a.locator('.layer-select').last().click()
  await a.getByLabel('불투명도').fill('50')
  await a.locator('.layer-eye').last().click()
  await a.locator('.layer-select').first().click()
  await a.getByText('이 브라우저에 저장됨', { exact: true }).waitFor()
  const before = await signatures(a)
  assert.equal(before.originals.length, 2)
  assert.notEqual(before.originals[0][5], before.originals[1][5])

  await check('failed registration keeps the original; explicit registration keeps the ID and hides v0', async () => {
    const route = '**/createServerArtwork'
    await a.route(route, req => req.abort())
    await a.getByRole('button', { name: '서버에 저장', exact: true }).click()
    await a.getByRole('button', { name: '서버에 저장', exact: true }).waitFor()
    await a.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === '서버에 저장')?.disabled)
    assert.deepEqual(await signatures(a), before)
    assert.equal(await remoteDocument(), null)
    await a.unroute(route)
    await a.getByRole('button', { name: '서버에 저장', exact: true }).click()
    await a.getByRole('button', { name: '편집 세션 받기' }).waitFor()
    assert.deepEqual(await call(a, 'createServerArtwork', { meta: { title: '중복 등록', widthPx: 800, heightPx: 800, backgroundColor: '#ffffff' } }),
      { serverVersion: 0, publication: 'pending' })
    assert.equal((await remoteDocument()).title.stringValue, '동기화 검증')
    assert.deepEqual(await call(b, 'listServerArtworks'), [])
  })
  const uploadRoute = /\/uploadArtworkPng\?/
  let firstJob
  await check('failed first PNG upload preserves durable queue; reload retries without publishing partial files', async () => {
    await a.route(uploadRoute, request => request.abort())
    await a.getByRole('button', { name: '편집 세션 받기' }).click()
    await a.getByRole('button', { name: '수정 시작' }).click()
    await a.getByText(/동기화 실패/).waitFor()
    firstJob = (await local(a)).job
    assert.ok(firstJob?.requestId)
    assert.equal((await remoteDocument()).serverVersion.integerValue, '0')
    assert.deepEqual(await call(b, 'listServerArtworks'), [])
    await assert.rejects(call(a, 'releaseEditSession', { proof: await proof(a) }), { code: 'functions/failed-precondition' })
    await assert.rejects(call(a, 'finalizeArtworkSave', { proof: await proof(a), requestId: firstJob.requestId }),
      { code: 'functions/failed-precondition' })
    const token = await a.evaluate(async () => (await import('/src/config/firebase.js')).auth.currentUser.getIdToken())
    const upload = new URL(`http://127.0.0.1:5001/${project}/asia-northeast3/uploadArtworkPng`)
    upload.search = new URLSearchParams({ artworkId: id, requestId: firstJob.requestId, layerId: before.originals[0][0] })
    const response = await fetch(upload, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'image/png', 'X-Edit-Proof': JSON.stringify(await proof(a)),
    }, body: Buffer.from('damaged image') })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'invalid-argument')
    await a.reload()
    await a.getByText(/동기화 실패/).waitFor()
    assert.equal((await local(a)).job.requestId, firstJob.requestId)
    await a.unroute(uploadRoute)
    await a.getByRole('button', { name: '동기화 다시 시도' }).click()
    await a.getByText('서버 동기화 완료', { exact: true }).waitFor({ timeout: 60000 })
    assert.deepEqual(await signatures(a), before)
    assert.equal((await local(a)).job, undefined)
  })
  let firstManifest
  await check('committed receipt is idempotent, stale version and stale or foreign proof are rejected', async () => {
    const credential = await proof(a)
    assert.equal((await remoteDocument()).serverVersion.integerValue, '1')
    firstManifest = await call(a, 'getServerArtwork')
    assert.equal(firstManifest.layers.length, 2)
    assert.ok(firstManifest.layers.every(layer => layer.image?.size > 0 && layer.currentRevisionId))
    assert.deepEqual(await call(a, 'finalizeArtworkSave', { proof: credential, requestId: firstJob.requestId }), (await local(a)).state.receipt)
    assert.equal((await remoteDocument()).serverVersion.integerValue, '1')
    const meta = { title: firstManifest.title, widthPx: 800, heightPx: 800, backgroundColor: '#ffffff' }
    await assert.rejects(call(a, 'prepareArtworkSave', { proof: credential, requestId: crypto.randomUUID(),
      expectedServerVersion: 0, localVersion: firstJob.localVersion + 1, meta, layers: firstManifest.layers }), { code: 'functions/failed-precondition' })
    for (const changed of [{ sessionId: 'wrong' }, { generation: credential.generation + 1 }, { token: 'b'.repeat(43) }]) {
      await assert.rejects(call(a, 'finalizeArtworkSave', { proof: { ...credential, ...changed }, requestId: firstJob.requestId }),
        { code: 'functions/permission-denied' })
    }
    await assert.rejects(call(c, 'getServerArtwork'), { code: 'functions/not-found' })
    assert.deepEqual(await call(c, 'listServerArtworks'), [])
  })
  await check('other browser downloads exact layer pixels and stays read-only while A holds the session', async () => {
    await b.goto(base)
    await b.getByRole('button', { name: '서버 작품 보기' }).click()
    await b.getByRole('button', { name: '동기화 검증 열기' }).click()
    await b.getByText('다른 기기에서 편집 중이므로 읽기 전용입니다.').waitFor()
    await b.locator('.drawcanvas[data-ready="true"]').waitFor()
    assert.deepEqual(await signatures(b), before)
    assert.equal(await b.locator('.drawcanvas').getAttribute('data-read-only'), 'true')
    await assert.rejects(call(b, 'acquireEditSession', { deviceId: 'other' }), { code: 'functions/already-exists' })
  })
  await check('offline edits preserve a later version; an interrupted upload preserves the previous commit', async () => {
    await a.context().setOffline(true)
    await draw(a, 0.51)
    await a.getByText('서버 동기화 대기 중', { exact: true }).waitFor()
    let requestHeld
    const started = new Promise(resolve => { requestHeld = resolve })
    let allowUpload
    const unblock = new Promise(resolve => { allowUpload = resolve })
    await a.route(uploadRoute, async request => { requestHeld(); await unblock; await request.continue() })
    await a.context().setOffline(false)
    try {
      await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(Error('Upload did not start')), 15000))])
      const queued = (await local(a)).job
      assert.ok(queued?.requestId)
      await draw(a, 0.63)
      const newer = await local(a)
      assert.equal(newer.job.requestId, queued.requestId)
      assert.ok(newer.state.localVersion > queued.localVersion)
      assert.equal((await remoteDocument()).serverVersion.integerValue, '1')
      assert.deepEqual(await call(b, 'getServerArtwork'), firstManifest)
      const download = await a.evaluate(async ([uid, id]) => {
        try {
          await (await import('/src/services/artworkSyncService.js')).downloadServerArtwork(uid, id)
          return 'overwrote'
        } catch (error) { return error.code }
      }, [uid, id])
      assert.equal(download, 'sync/conflict')
    } finally { allowUpload() }
    await a.getByText('서버 동기화 완료', { exact: true }).waitFor({ timeout: 60000 })
    await a.unroute(uploadRoute)
    const later = await call(a, 'getServerArtwork')
    assert.equal(later.serverVersion, 3)
    assert.equal(later.layers[1].currentRevisionId, firstManifest.layers[1].currentRevisionId)
    assert.notEqual(later.layers[0].currentRevisionId, firstManifest.layers[0].currentRevisionId)
  })
  await check('release confirms the latest receipt, rejects the old token, and B acquires after refresh', async () => {
    const latestPixels = await signatures(a)
    const credential = await proof(a)
    const receipt = (await local(a)).state.receipt
    await a.getByRole('button', { name: '서버 저장 후 편집 종료' }).click()
    await a.getByRole('button', { name: '편집 세션 받기' }).waitFor()
    await assert.rejects(call(a, 'finalizeArtworkSave', { proof: credential, requestId: receipt.requestId }), { code: 'functions/permission-denied' })
    await b.goto(base)
    await b.getByRole('button', { name: '서버 작품 보기' }).click()
    await b.getByRole('button', { name: '동기화 검증 열기' }).click()
    await b.locator('.drawcanvas[data-ready="true"]').waitFor()
    assert.equal((await local(b)).state.serverVersion, receipt.serverVersion)
    assert.deepEqual(await signatures(b), latestPixels)
    await b.getByRole('button', { name: '편집 세션 받기' }).click()
    await b.getByRole('button', { name: '수정 시작' }).waitFor()
    await b.getByRole('button', { name: '변경 없이 세션 반납' }).click()
    await b.getByRole('button', { name: '편집 세션 받기' }).waitFor()
  })
  await check('committed PNG has no client overwrite or direct access and requests stayed local', async () => {
    const fields = await remoteDocument()
    const path = fields.layerManifest.arrayValue.values[0].mapValue.fields.pngPath.stringValue
    const token = await c.evaluate(async () => (await import('/src/config/firebase.js')).auth.currentUser.getIdToken())
    assert.equal((await fetch(`${firebaseStorage}/${encodeURIComponent(path)}?alt=media`,
      { headers: { Authorization: `Firebase ${token}` } })).status, 403)
    const ownerToken = await a.evaluate(async () => (await import('/src/config/firebase.js')).auth.currentUser.getIdToken())
    const boundary = 'stage5c-test-boundary'
    const multipart = [
      `--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify({ name: path, contentType: 'image/png' })}`,
      `--${boundary}\r\nContent-Type: image/png\r\n\r\nforbidden overwrite`,
      `--${boundary}--\r\n`,
    ].join('\r\n')
    assert.equal((await fetch(`${firebaseStorage}?name=${encodeURIComponent(path)}`, { method: 'POST',
      headers: { Authorization: `Firebase ${ownerToken}`, 'X-Goog-Upload-Protocol': 'multipart',
        'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart })).status, 403)
    const u = new URL(`http://127.0.0.1:5001/${project}/asia-northeast3/downloadArtworkPng`)
    u.search = new URLSearchParams({ artworkId: id, layerId: firstManifest.layers[0].layerId, version: 3 })
    assert.equal((await fetch(u, { headers: { Authorization: `Bearer ${token}` } })).status, 404)
    assert.equal((await fetch(u)).status, 401)
    assert.deepEqual(blocked, [])
  })
  await check('next device saves a title and PNG, reloads before acknowledging the receipt, and A downloads one updated card', async () => {
    const rename = '동기화 검증 새 이름'
    const button = name => b.getByRole('button', { name, exact: true })
    await button('편집 세션 받기').click()
    await button('수정 시작').click()
    await b.locator('.drawcanvas[data-ready="true"][data-read-only="false"]').waitFor()
    await waitForLocalReceipt(b, 4)
    const original = await signatures(b)
    const done = b.getByText('서버 동기화 완료', { exact: true })
    await b.context().setOffline(true)
    b.once('dialog', dialog => dialog.accept(rename))
    await button('작품 제목 변경').click()
    await b.getByText(rename, { exact: true }).waitFor()
    await draw(b, 0.74)
    const pixels = await signatures(b)
    assert.notDeepEqual(pixels, original)
    assert.equal((await remoteDocument()).title.stringValue, '동기화 검증')
    assert.equal((await remoteDocument()).serverVersion.integerValue, '4')
    assert.ok((await local(b)).job)

    let markCommitted, unblockResponse
    const committed = new Promise(resolve => { markCommitted = resolve })
    const waitForReload = new Promise(resolve => { unblockResponse = resolve })
    const finalize = '**/finalizeArtworkSave'
    let first = true
    await b.route(finalize, async route => {
      if (!first || route.request().method() !== 'POST') return route.continue()
      first = false
      const response = await route.fetch()
      markCommitted(response.status())
      await waitForReload
      await route.abort().catch(() => {})
    })
    try {
      await b.context().setOffline(false)
      let timer
      try {
        assert.equal(await Promise.race([committed, new Promise(resolve => { timer = setTimeout(() => resolve(0), 25000) })]), 200)
      } finally { clearTimeout(timer) }
      const job = (await local(b)).job
      assert.ok(job?.requestId)
      assert.equal((await remoteDocument()).serverVersion.integerValue, '5')
      assert.equal((await local(b)).state.serverVersion, 4)
      await b.reload()
      await b.locator('.drawcanvas[data-ready="true"][data-read-only="false"]').waitFor()
      await done.waitFor({ timeout: 60000 })
      assert.equal((await local(b)).state.receipt.requestId, job.requestId)
      assert.equal((await local(b)).job, undefined)
      assert.equal((await remoteDocument()).serverVersion.integerValue, '5')
      assert.equal((await remoteDocument()).title.stringValue, rename)
      assert.deepEqual(await signatures(b), pixels)
    } finally {
      unblockResponse()
      await b.unroute(finalize)
    }
    assert.equal(await b.evaluate(async ({ uid, id }) => {
      try { await (await import('/src/repositories/artworkRepository.js')).deleteArtwork(uid, id); return 'allowed' }
      catch (error) { return error.code }
    }, { uid, id }), 'artwork/read-only')
    assert.equal((await remoteDocument()).state.stringValue, 'active')
    await button('서버 저장 후 편집 종료').click()
    await button('편집 세션 받기').waitFor()
    await a.goto(base)
    await a.getByRole('button', { name: '동기화 검증 열기', exact: true }).waitFor()
    await Promise.all([
      a.waitForResponse(response => response.url().endsWith('/listServerArtworks') && response.ok()),
      a.getByRole('button', { name: '서버 작품 보기' }).click(),
    ])
    await a.getByRole('button', { name: `${rename} 열기`, exact: true }).waitFor()
    assert.equal(await a.locator('.artwork-card').count(), 1)
    assert.equal((await local(a)).title, '동기화 검증')
    await a.getByRole('textbox', { name: '작품 검색' }).fill('새 이름')
    await a.getByRole('button', { name: `${rename} 열기`, exact: true }).click()
    await a.locator('.drawcanvas[data-ready="true"]').waitFor()
    assert.equal((await local(a)).state.serverVersion, 5)
    assert.equal((await local(a)).title, rename)
    assert.deepEqual(await signatures(a), pixels)
  })

  let oversized
  await check('oversize raster keeps local PNG and frozen queue; Firestore version and receipt stay fixed', async () => {
    await b.getByRole('button', { name: '편집 세션 받기', exact: true }).click()
    await b.getByRole('button', { name: '수정 시작', exact: true }).click()
    await b.locator('.drawcanvas[data-ready="true"][data-read-only="false"]').waitFor()
    await waitForLocalReceipt(b, 6)
    const manifest = await call(b, 'getServerArtwork')
    const limit = 8 * 1024 * 1024
    const { title, widthPx, heightPx, backgroundColor } = manifest
    const invalidLayers = manifest.layers.map((layer, index) => index ? layer : { ...layer, image: { hash: 'a'.repeat(64), size: limit + 1 } })
    await assert.rejects(call(b, 'prepareArtworkSave', { proof: await proof(b), requestId: crypto.randomUUID(),
      expectedServerVersion: manifest.serverVersion, localVersion: (await local(b)).state.localVersion + 1,
      meta: { title, widthPx, heightPx, backgroundColor }, layers: invalidLayers }), { code: 'functions/invalid-argument' })
    const { layerId, size, hash } = await b.evaluate(async ({ uid, id, limit }) => {
      const { localDb } = await import('/src/db/localDb.js')
      const { saveLayerChanges } = await import('/src/repositories/layerRepository.js')
      const layers = await localDb.layers.where('[uid+artworkId]').equals([uid, id]).toArray()
      const visibleLayer = layers.find(layer => layer.visible)
      const original = await localDb.layerContents.get([uid, id, visibleLayer.layerId])
      // 실제 PNG 헤더를 가진 크기 경계 픽스처. 서버로 전송하기 전에 차단되어야 한다.
      const pngBlob = new Blob([original.pngBlob, new Uint8Array(limit)], { type: 'image/png' })
      await saveLayerChanges(uid, id, { previousIds: layers.map(layer => layer.layerId), contents: [{ ...original, pngBlob }] })
      const digest = await crypto.subtle.digest('SHA-256', await pngBlob.arrayBuffer())
      return { layerId: original.layerId, size: pngBlob.size, hash: new Uint8Array(digest).join('.') }
    }, { uid, id, limit })
    await b.getByText(/동기화 실패.*8 MiB/).waitFor()
    const state = await local(b)
    assert.ok(state.job?.requestId && state.state.failure.terminal)
    assert.equal(Number((await remoteDocument()).serverVersion.integerValue), manifest.serverVersion)
    assert.deepEqual(await call(b, 'getServerArtwork'), manifest)
    const retainedSizes = await b.evaluate(async ({ uid, id, layerId }) => {
      const { localDb } = await import('/src/db/localDb.js')
      const original = await localDb.layerContents.get([uid, id, layerId])
      const frozen = (await localDb.syncQueue.get([uid, id])).contents.find(layer => layer.layerId === layerId)
      return [original.pngBlob.size, frozen.pngBlob.size]
    }, { uid, id, layerId })
    assert.deepEqual(retainedSizes, [size, size])
    assert.equal((await fetch(`${docs}/users/${uid}/artworks/${id}/saveReceipts/${state.job.requestId}`, { headers: admin })).status, 404)
    oversized = { layerId, size, hash, requestId: state.job.requestId }
  })

  await check('explicit retry archives the rejected PNG before sending the user-edited layer', async () => {
    const retry = b.getByRole('button', { name: '레이어 수정 후 동기화 다시 시도', exact: true })
    await retry.click()
    await b.getByRole('alert').filter({ hasText: '8 MiB를 넘는 레이어를 수정' }).waitFor()
    assert.equal((await local(b)).job.requestId, oversized.requestId)
    const layerIndex = await b.evaluate(async ({ uid, id, layerId }) => {
      const { localDb } = await import('/src/db/localDb.js')
      return (await localDb.layers.get([uid, id, layerId])).sortOrder
    }, { uid, id, layerId: oversized.layerId })
    await b.getByRole('button', { name: '레이어 패널 열기' }).click()
    await b.locator('.layer-select').nth(layerIndex).click()
    await draw(b, 0.65)
    await retry.click()
    await waitForLocalReceipt(b, 7)
    const { state } = await local(b)
    assert.notEqual(state.receipt.requestId, oversized.requestId)
    assert.equal((await remoteDocument()).serverVersion.integerValue, '7')
    const preserved = await b.evaluate(async ({ uid, id, oversized }) => {
      const { localDb } = await import('/src/db/localDb.js')
      const drafts = await localDb.recoveryDrafts.where('[uid+artworkId]').equals([uid, id]).toArray()
      const draft = drafts.find(row => row.reason === 'png_size')
      const archived = draft.failedJob.contents.find(layer => layer.layerId === oversized.layerId).pngBlob
      const digest = await crypto.subtle.digest('SHA-256', await archived.arrayBuffer())
      return {
        pending: draft.pendingRequestIds,
        archivedSize: archived.size,
        archivedHash: new Uint8Array(digest).join('.'),
        newSize: (await localDb.layerContents.get([uid, id, oversized.layerId])).pngBlob.size,
      }
    }, { uid, id, oversized })
    assert.deepEqual(preserved.pending, [oversized.requestId])
    assert.equal(preserved.archivedSize, oversized.size)
    assert.equal(preserved.archivedHash, oversized.hash)
    assert.ok(preserved.newSize < 8 * 1024 * 1024)
  })
  await check('leaving_the_list_cancels_a_pending_download_and_keeps_the_current_artwork', async () => {
    const page = await tab()
    let release
    let intercepted
    const gate = new Promise(resolve => { release = resolve })
    const waiting = new Promise(resolve => { intercepted = resolve })
    try {
      await account(page, email, false)
      await page.goto(base)
      const localId = await page.evaluate(async uid => (await (await import('/src/repositories/artworkRepository.js'))
        .createArtwork(uid, { title: '이동 확인용 작품' })).artworkId, uid)
      await page.getByRole('button', { name: '이동 확인용 작품 열기', exact: true }).click()
      const localUrl = `${base}/drawing/${localId}`
      await page.waitForURL(localUrl)
      await page.getByRole('link', { name: '작품 목록', exact: true }).click()
      await page.getByRole('button', { name: '서버 작품 보기', exact: true }).click()
      const { title: remoteTitle } = await call(page, 'getServerArtwork')
      await page.route('**/downloadArtworkPng?*', async route => {
        if (route.request().method() !== 'GET') return route.fallback()
        intercepted()
        await gate
        await route.continue().catch(() => {})
      })
      await page.getByRole('button', { name: `${remoteTitle} 열기`, exact: true }).click()
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('No pending PNG download')), 15000)
        void waiting.then(() => { clearTimeout(timeout); resolve() })
      })
      await page.evaluate(() => history.back())
      await page.waitForURL(localUrl)
      await page.locator('.drawcanvas[data-ready="true"]').waitFor()
      release()
      const reopened = await page.waitForURL(`${base}/drawing/${id}`, { timeout: 2000 })
        .then(() => true, error => { if (error.name === 'TimeoutError') return false; throw error })
      assert.equal(reopened, false, 'a stale download must not navigate away from the current artwork')
      assert.equal(page.url(), localUrl)
      assert.equal((await local(page)).title, undefined, 'the canceled download must not install an artwork')
    } finally {
      release()
      await page.context().close()
    }
  })
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await browser?.close()
  await server?.close()
  async function cleanup(url, init) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) })
      if (!response.ok && response.status !== 404) throw new Error(`Cleanup HTTP ${response.status}`)
      return response
    } catch (error) { console.error(error.message); process.exitCode = 1 }
  }
  if (uid && id) {
    const path = `users/${uid}/artworks/${id}`
    for (const child of ['layers', 'editSession', 'saveReceipts', 'revisions', 'sessionRecoveries']) {
      const result = await cleanup(`${docs}/${path}/${child}`, { headers: admin })
      for (const doc of (await result?.json())?.documents ?? []) {
        const suffix = doc.name.split('/documents/')[1]
        if (suffix.startsWith(`${path}/`)) await cleanup(`${docs}/${suffix}`, { headers: admin, method: 'DELETE' })
      }
    }
    const files = await cleanup(`${gcs}?prefix=${encodeURIComponent(path + '/')}`, { headers: admin })
    for (const item of (await files?.json())?.items ?? []) {
      if (item.name.startsWith(path + '/')) await cleanup(`${firebaseStorage}/${encodeURIComponent(item.name)}`, { headers: admin, method: 'DELETE' })
    }
    await cleanup(`${docs}/${path}`, { headers: admin, method: 'DELETE' })
  }
  for (const user of users) {
    await cleanup(`${docs}/users/${user}`, { headers: admin, method: 'DELETE' })
    await cleanup(`http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/${project}/accounts:delete`,
      { method: 'POST', headers: { ...admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ localId: user }) })
  }
  console.log(`5-C checks passed: ${passed}`)
}
