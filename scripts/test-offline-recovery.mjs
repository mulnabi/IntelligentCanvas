import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright')
const base = 'http://127.0.0.1:5193'
const project = 'ai-drawing-a9177'
const bucket = 'intelligentcanvas-stage5a-local.invalid'
const docs = `http://127.0.0.1:8080/v1/projects/${project}/databases/(default)/documents`
const objects = `http://127.0.0.1:9199/storage/v1/b/${bucket}/o`
const admin = { Authorization: 'Bearer owner' }
const run = crypto.randomUUID()
const email = `stage5d-${run}@example.test`
const password = `Stage5d-${run}!`
const users = []
const catalogFixtures = []
const title = '오프라인 통합 검증'
let server, browser, uid, id, passed = 0

async function check(name, work) { await work(); console.log(`PASS ${name}`); passed++ }
async function http(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000), ...options })
  if (!response.ok) throw new Error(`Emulator fixture HTTP ${response.status}`)
  return response
}
const artworkPath = () => `users/${uid}/artworks/${id}`
async function readDoc(path) {
  const target = [artworkPath(), path].filter(Boolean).join('/')
  return (await (await http(`${docs}/${target}`, { headers: admin })).json()).fields
}
async function openProfile() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.grantPermissions(['local-network-access'], { origin: base })
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    return url.hostname === '127.0.0.1' && ['5193', '9099', '8080', '5001'].includes(url.port)
      ? route.continue() : route.abort()
  })
  const page = await context.newPage()
  page.setDefaultTimeout(18000)
  await page.goto(base)
  return page
}
async function account(page, address, create) {
  const user = await page.evaluate(async ({ address, password, create }) => {
    const { registerUser, loginUser } = await import('/src/services/authService.js')
    return create ? (await registerUser({ email: address, password, username: '5-D 검증' })).user.uid
      : (await loginUser({ email: address, password })).uid
  }, { address, password, create })
  if (create) users.push(user)
  return user
}
async function call(page, name, input = {}) {
  const outcome = await page.evaluate(async ({ name, input, id }) => {
    try {
      return { result: await (await import('/src/services/editSessionService.js')).callEditSession(name, id, input) }
    } catch (error) { return { code: error.code } }
  }, { name, input, id })
  if (outcome.code) throw Object.assign(new Error(`Callable ${name} rejected`), { code: outcome.code })
  return outcome.result
}
const canvas = page => page.locator('.drawcanvas[data-ready="true"]')
const button = (page, name) => page.getByRole('button', { name, exact: true })
const synced = page => page.getByText('서버 동기화 완료', { exact: true }).waitFor({ timeout: 60000 })
const saved = page => page.getByText('이 브라우저에 저장됨', { exact: true }).waitFor()
const proof = page => page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), `intelligentcanvas:editing:${uid}:${id}`)
async function begin(page) {
  const expectedVersion = (await local(page)).state.serverVersion + 1
  await button(page, '수정 시작').click()
  await page.locator('.drawcanvas[data-ready="true"][data-read-only="false"]').waitFor()
  await synced(page)
  assert.equal((await local(page)).state.serverVersion, expectedVersion)
}
async function draw(page, row) {
  const box = await canvas(page).boundingBox()
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * row)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.57, box.y + box.height * row, { steps: 12 })
  await page.mouse.up()
  await saved(page)
}
async function openFromServer(page) {
  await page.goto(base)
  await button(page, '서버 작품 보기').click()
  await button(page, `${title} 열기`).click()
  await canvas(page).waitFor()
}
async function local(page) {
  return page.evaluate(async key => {
    const { localDb } = await import('/src/db/localDb.js')
    const [state, job, drafts] = await Promise.all([
      localDb.artworkSync.get(key), localDb.syncQueue.get(key), localDb.recoveryDrafts.where('[uid+artworkId]').equals(key).toArray(),
    ])
    return { state, job: job && { requestId: job.requestId, state: job.state }, drafts: drafts.map(row => row.draftId) }
  }, [uid, id])
}
async function pixelSignatures(page, draftId = null, artworkId = id) {
  return page.evaluate(async ({ uid, id, draftId }) => {
    const { localDb } = await import('/src/db/localDb.js')
    const draft = draftId && await localDb.recoveryDrafts.get(draftId)
    const layers = draft ? draft.layersSnapshot : await localDb.layers.where('[uid+artworkId]').equals([uid, id]).sortBy('sortOrder')
    const originals = []
    for (const { layerId, name, opacity, visible } of layers) {
      const blob = (draft ? draft.layerContentsSnapshot.find(row => row.layerId === layerId)
        : await localDb.layerContents.get([uid, id, layerId]))?.pngBlob
      let hash = null
      if (blob) {
        const bitmap = await createImageBitmap(blob)
        const output = new OffscreenCanvas(bitmap.width, bitmap.height)
        const ctx = output.getContext('2d')
        ctx.drawImage(bitmap, 0, 0)
        bitmap.close()
        const pixels = ctx.getImageData(0, 0, output.width, output.height).data
        hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))).join('.')
      }
      originals.push({ layerId, name, opacity, visible, hash })
    }
    return originals
  }, { uid, id: artworkId, draftId })
}

try {
  server = await createServer({ cacheDir: '.firebase/vite-stage5d',
    optimizeDeps: { include: ['firebase/auth', 'firebase/firestore', 'firebase/functions', 'firebase/storage'] },
    server: { host: '127.0.0.1', port: 5193, strictPort: true }, logLevel: 'error' })
  await server.listen()
  browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'msedge', headless: true })
  const a = await openProfile()
  const b = await openProfile()
  const outsider = await openProfile()

  await check('Dexie v4 artwork, raster and frozen queue survive v5 migration', async () => {
    const fixture = await openProfile()
    try {
      const upgraded = await fixture.evaluate(async () => {
        const key = ['fixture', 'v4']
        const canvas = new OffscreenCanvas(2, 2)
        canvas.getContext('2d').fillRect(0, 0, 1, 1)
        const blob = await canvas.convertToBlob()
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('IntelligentCanvasLocal', 40)
          request.onupgradeneeded = () => {
            const db = request.result
            const artwork = db.createObjectStore('artworks', { keyPath: ['uid', 'artworkId'] })
            artwork.createIndex('[uid+state+updatedAt]', ['uid', 'state', 'updatedAt'])
            artwork.createIndex('[uid+state+createdAt]', ['uid', 'state', 'createdAt'])
            artwork.put({ uid: key[0], artworkId: key[1], title: '원본' })
            db.createObjectStore('canvasContents', { keyPath: ['uid', 'artworkId'] })
            db.createObjectStore('layers', { keyPath: ['uid', 'artworkId', 'layerId'] })
              .createIndex('[uid+artworkId+sortOrder]', ['uid', 'artworkId', 'sortOrder'])
            db.createObjectStore('layerContents', { keyPath: ['uid', 'artworkId', 'layerId'] })
              .put({ uid: key[0], artworkId: key[1], layerId: 'raster', pngBlob: blob })
            db.createObjectStore('artworkSync', { keyPath: ['uid', 'artworkId'] })
              .put({ uid: key[0], artworkId: key[1], localVersion: 3, ackLocalVersion: 1 })
            const queue = db.createObjectStore('syncQueue', { keyPath: ['uid', 'artworkId'] })
            queue.createIndex('uid', 'uid')
            queue.put({ uid: key[0], artworkId: key[1], requestId: 'v4-frozen', contents: [{ pngBlob: blob }] })
          }
          request.onsuccess = () => { request.result.close(); resolve() }
          request.onerror = () => reject(request.error)
        })
        const { localDb } = await import('/src/db/localDb.js')
        const [art, raster, job] = await Promise.all([
          localDb.artworks.get(key), localDb.layerContents.get([...key, 'raster']), localDb.syncQueue.get(key),
        ])
        const original = new Uint8Array(await blob.arrayBuffer()).join()
        return localDb.verno === 5 && art.title === '원본' && job.requestId === 'v4-frozen'
          && original === new Uint8Array(await raster.pngBlob.arrayBuffer()).join()
          && original === new Uint8Array(await job.contents[0].pngBlob.arrayBuffer()).join()
      })
      assert.equal(upgraded, true)
    } finally { await fixture.context().close() }
  })

  uid = await account(a, email, true)
  assert.equal(await account(b, email, false), uid)
  id = await a.evaluate(async ({ uid, title }) => (await (await import('/src/repositories/artworkRepository.js'))
    .createArtwork(uid, { title, width: 800, height: 800 })).artworkId, { uid, title })
  await a.goto(`${base}/drawing/${id}`)
  await canvas(a).waitFor()
  await draw(a, 0.29)
  await button(a, '서버에 저장').click()
  await button(a, '편집 세션 받기').click()
  await begin(a)

  await check('offline local edits sync on reconnect, with exclusive session until explicit release', async () => {
    const initial = await proof(a)
    await a.context().setOffline(true)
    await button(a, '레이어 패널 열기').click()
    await button(a, '레이어 추가').click()
    await draw(a, 0.40)
    await a.getByText('서버 동기화 대기 중', { exact: true }).waitFor()
    assert.ok((await local(a)).job)
    await openFromServer(b)
    assert.equal(await canvas(b).getAttribute('data-read-only'), 'true')
    await assert.rejects(call(b, 'acquireEditSession', { deviceId: 'test-b' }), { code: 'functions/already-exists' })
    const before = await call(b, 'listArtworkRevisions')
    assert.equal(before.length, 1)
    await a.context().setOffline(false)
    await synced(a)
    assert.equal((await local(a)).job, undefined)
    assert.equal((await call(a, 'getEditSessionStatus', { proof: initial })).status, 'held')
    await button(a, '서버 저장 후 편집 종료').click()
    await button(a, '편집 세션 받기').waitFor()
    await button(b, '편집 권한 다시 확인').click()
    await button(b, '편집 세션 받기').click()
    await button(b, '변경 없이 세션 반납').click()
    await button(b, '편집 세션 받기').waitFor()
  })

  await button(a, '편집 세션 받기').click()
  await begin(a)
  const old = await proof(a)
  const abortFinalize = '**/finalizeArtworkSave'
  const denyStatus = '**/getEditSessionStatus'
  let stagedJob, stagingPath, uncommittedPixels, historyBefore
  await check('failed finalize leaves no revision; offline reload with verified grant preserves the local queue', async () => {
    historyBefore = await call(b, 'listArtworkRevisions')
    await a.route(abortFinalize, route => route.abort())
    await draw(a, 0.47)
    await a.getByText(/동기화 실패/).waitFor()
    stagedJob = (await local(a)).job.requestId
    const receipt = await readDoc(`saveReceipts/${stagedJob}`)
    stagingPath = Object.values(receipt.stage.mapValue.fields ?? {})[0]?.stringValue
    assert.ok(stagingPath, 'Failed finalize must keep the uploaded staging object')
    const before = await call(b, 'listArtworkRevisions')
    assert.deepEqual(before, historyBefore)
    assert.equal((await call(b, 'cleanupArtworkStaging', { requestId: stagedJob, execute: true })).eligible, false)
    await a.context().setOffline(true)
    await button(a, '레이어 추가').click()
    await draw(a, 0.54)
    uncommittedPixels = await pixelSignatures(a)
    await a.route(denyStatus, route => route.abort())
    await a.context().setOffline(false)
    await a.reload()
    assert.equal(await canvas(a).getAttribute('data-read-only'), 'false')
    assert.equal((await local(a)).job.requestId, stagedJob)
    assert.deepEqual(await pixelSignatures(a), uncommittedPixels)
  })

  await check('offline reload cannot edit with the correct device and generation but an unverified token', async () => {
    const key = `intelligentcanvas:editing:${uid}:${id}`
    const original = await proof(a)
    const forged = { ...original, token: (original.token[0] === 'a' ? 'b' : 'a') + original.token.slice(1) }
    await a.evaluate(({ key, forged }) => sessionStorage.setItem(key, JSON.stringify(forged)), { key, forged })
    await a.reload()
    assert.equal(await canvas(a).getAttribute('data-read-only'), 'true')
    await a.evaluate(({ key, original }) => sessionStorage.setItem(key, JSON.stringify(original)), { key, original })
    await a.reload()
    assert.equal(await canvas(a).getAttribute('data-read-only'), 'false')
  })

  await check('cancel keeps old session; explicit confirmation replaces exactly once under concurrent requests', async () => {
    await openFromServer(b)
    const details = await call(b, 'getEditSessionStatus', { details: true })
    assert.equal(Object.keys(details).sort().join(), 'canRecover,generation,serverVersion,sessionRef,status')
    assert.equal(details.sessionRef === old.sessionId, false)
    const selection = { sessionRef: details.sessionRef, generation: details.generation, deviceId: 'test-b' }
    await assert.rejects(call(b, 'forceRecoverEditSession', { ...selection, confirmed: false }), { code: 'functions/invalid-argument' })
    b.once('dialog', dialog => dialog.dismiss())
    await button(b, '강제 복구').click()
    assert.equal((await call(b, 'getEditSessionStatus', { details: true })).generation, old.generation)
    let winners = 0
    await b.route('**/forceRecoverEditSession', async route => {
      if (route.request().method() !== 'POST') return route.continue()
      const replies = await Promise.all([route.fetch(), route.fetch()])
      winners = replies.filter(reply => reply.ok()).length
      await route.fulfill({ response: replies.find(reply => reply.ok()) ?? replies[0] })
    })
    b.once('dialog', dialog => dialog.accept())
    await button(b, '강제 복구').click()
    await button(b, '수정 시작').waitFor()
    await b.unroute('**/forceRecoverEditSession')
    const fresh = await proof(b)
    assert.equal(winners, 1)
    assert.equal(fresh.generation, old.generation + 1)
    assert.equal(fresh.sessionId === old.sessionId || fresh.token === old.token, false)
    assert.equal((await readDoc(`saveReceipts/${stagedJob}`)).status.stringValue, 'abandoned')
    await readDoc(`sessionRecoveries/${fresh.generation}`)
    await assert.rejects(call(b, 'finalizeArtworkSave', { proof: old, requestId: stagedJob }), { code: 'functions/permission-denied' })
    await assert.rejects(call(b, 'releaseEditSession', { proof: old }), { code: 'functions/permission-denied' })
  })

  await check('confirmed layer changes produce one text revision with server time; replays do not duplicate it', async () => {
    await begin(b)
    await button(b, '레이어 패널 열기').click()
    await b.context().setOffline(true)
    await draw(b, 0.64)
    await b.getByLabel('불투명도').fill('50')
    await button(b, '레이어 추가').click()
    await saved(b)
    await b.context().setOffline(false)
    await synced(b)
    const latest = await call(b, 'listArtworkRevisions')
    assert.equal(latest.length, historyBefore.length + 1)
    const top = latest[0]
    assert.ok(top.createdAt > Date.now() - 120000)
    assert.equal(top.changedLayers.length, 2)
    for (const operation of ['layer_created', 'layer_pixels_modified', 'layer_opacity_changed']) assert.ok(top.operationTypes.includes(operation))
    const { requestId } = (await local(b)).state.receipt
    assert.equal(top.revisionId, requestId)
    const receipt = await call(b, 'finalizeArtworkSave', { proof: await proof(b), requestId })
    assert.equal(receipt.serverVersion, top.serverVersion)
    assert.deepEqual(await call(b, 'listArtworkRevisions'), latest)
    await account(outsider, `other-${email}`, true)
    await assert.rejects(call(outsider, 'listArtworkRevisions'), { code: 'functions/not-found' })
    await assert.rejects(call(outsider, 'cleanupArtworkStaging', { requestId: stagedJob }), { code: 'functions/not-found' })
    const ownerToken = await b.evaluate(async () => (await import('/src/config/firebase.js')).auth.currentUser.getIdToken())
    const headers = { Authorization: `Bearer ${ownerToken}` }
    const revisionUrl = `${docs}/${artworkPath()}/revisions/${requestId}`
    assert.equal((await fetch(revisionUrl, { headers })).status, 403)
    assert.equal((await fetch(revisionUrl, { method: 'DELETE', headers })).status, 403)
  })

  await check('reconnect quarantines the old queue only after saving exact PNGs and never merges into B', async () => {
    const serverPixels = await pixelSignatures(b)
    const version = (await call(b, 'getServerArtwork')).serverVersion
    let uploads = 0
    a.on('request', request => { if (request.url().includes('/uploadArtworkPng?')) uploads++ })
    // 같은 브라우저의 다른 탭은 기존 편집 탭이 잠금을 가진 동안 초안을 먼저 확정하지 않는다.
    const viewer = await a.context().newPage()
    try {
      await viewer.goto(`${base}/drawing/${id}?view=server`)
      await viewer.getByText('이 브라우저의 작업 초안은 기존 편집 탭에서 보존합니다.', { exact: true }).waitFor()
      assert.equal(await canvas(viewer).getAttribute('data-read-only'), 'true')
      assert.equal((await local(a)).drafts.length, 0)
      assert.notEqual((await local(a)).job.state, 'quarantined')
    } finally { await viewer.close() }
    await a.evaluate(async () => {
      const { localDb } = await import('/src/db/localDb.js')
      const add = localDb.recoveryDrafts.add
      localDb.recoveryDrafts.add = () => Promise.reject(new Error('simulated draft write failure'))
      window.restoreDraftWriter = () => { localDb.recoveryDrafts.add = add }
    })
    await a.unroute(denyStatus)
    await a.unroute(abortFinalize)
    await a.evaluate(() => window.dispatchEvent(new Event('online')))
    await button(a, '초안 보존 다시 시도').waitFor()
    assert.equal(await canvas(a).getAttribute('data-read-only'), 'true')
    assert.equal((await local(a)).drafts.length, 0)
    assert.notEqual((await local(a)).job.state, 'quarantined')
    assert.deepEqual(await pixelSignatures(a), uncommittedPixels)
    await a.evaluate(() => window.restoreDraftWriter())
    await button(a, '초안 보존 다시 시도').click()
    try {
      await a.getByText('이 브라우저의 복구 초안 (1)', { exact: true }).waitFor()
    } catch (error) {
      const current = await local(a)
      console.error('Draft retry status', { drafts: current.drafts.length, queue: current.job?.state,
        revoked: current.state.failure?.revoked, steps: await a.locator('aside [role="status"], aside [role="alert"]').allTextContents() })
      throw error
    }
    const protectedLocal = await local(a)
    assert.equal(protectedLocal.job.state, 'quarantined')
    assert.equal(protectedLocal.job.requestId, stagedJob)
    assert.deepEqual(await pixelSignatures(a, protectedLocal.drafts[0]), uncommittedPixels)
    assert.deepEqual(await pixelSignatures(a), uncommittedPixels)
    assert.equal(uploads, 0)
    assert.equal((await call(b, 'getServerArtwork')).serverVersion, version)
    assert.deepEqual(await pixelSignatures(b), serverPixels)
    assert.equal((await local(b)).drafts.length, 0)
    await a.reload()
    assert.equal(await canvas(a).getAttribute('data-read-only'), 'true')
    assert.equal((await local(a)).drafts.length, 1)
    await a.getByText('이 브라우저의 복구 초안 (1)', { exact: true }).click()
    await button(a, '초안 미리보기').click()
    await a.getByLabel('복구 초안 미리보기').waitFor()
    await a.waitForFunction(() => {
      const preview = document.querySelector('canvas[aria-label="복구 초안 미리보기"]')
      return preview.getContext('2d').getImageData(0, 0, preview.width, preview.height).data.some(value => value !== 0)
    })
    await a.getByText('수정 이력', { exact: true }).click()
    await a.getByText(/레이어.*불투명도 변경/).waitFor()
  })

  await check('draft is UID-scoped and can be copied to a new local artwork with identical pixels', async () => {
    const draftId = (await local(a)).drafts[0]
    const foreignUid = users[1]
    const denied = await a.evaluate(async ({ foreignUid, id, draftId }) => {
      try {
        await (await import('/src/repositories/recoveryDraftRepository.js')).getRecoveryDraft(foreignUid, id, draftId)
        return false
      } catch (error) { return error.code === 'artwork/auth-changed' }
    }, { foreignUid, id, draftId })
    assert.equal(denied, true)
    await button(a, '별도 로컬 작품으로 복제').click()
    const link = a.getByRole('link', { name: '복제한 로컬 작품 열기' })
    const copyId = (await link.getAttribute('href')).split('/').at(-1)
    assert.notEqual(copyId, id)
    assert.deepEqual(await pixelSignatures(a, null, copyId), uncommittedPixels)
    assert.equal((await local(a)).drafts.length, 1)
    await link.click()
    await canvas(a).waitFor()
    assert.equal(await canvas(a).getAttribute('data-read-only'), 'false')
    await button(a, '서버에 저장').waitFor()
  })

  await check('reopening the server artwork shows the exact committed pixels alongside the preserved local draft', async () => {
    const before = await local(a)
    const firestore = await readDoc('')
    const version = Number(firestore.serverVersion.integerValue)
    assert.ok(version > before.state.serverVersion)
    assert.equal(version, (await local(b)).state.receipt.serverVersion)
    assert.equal(version, (await call(b, 'getServerArtwork')).serverVersion)
    const layers = []
    for (const item of firestore.layerManifest.arrayValue.values) {
      const row = item.mapValue.fields
      let bytes = null
      if (row.pngPath.stringValue) {
        assert.equal(row.pngPath.stringValue,
          `${artworkPath()}/layers/${row.layerId.stringValue}/${row.currentRevisionId.stringValue}/raster.png`)
        const png = await http(`${objects}/${encodeURIComponent(row.pngPath.stringValue)}?alt=media`, { headers: admin })
        bytes = Array.from(new Uint8Array(await png.arrayBuffer()))
      }
      layers.push({ bytes, visible: row.visible.booleanValue, opacity: Number(row.opacity.doubleValue ?? row.opacity.integerValue) })
    }
    assert.ok(layers.some(layer => layer.bytes?.length))
    const expected = await b.evaluate(async ({ layers, width, height }) => {
      const output = new OffscreenCanvas(width, height)
      const ctx = output.getContext('2d')
      for (const { bytes, opacity, visible } of layers.reverse()) {
        if (!bytes || !visible || opacity === 0) continue
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: 'image/png' }))
        ctx.globalAlpha = opacity
        ctx.drawImage(bitmap, 0, 0)
        bitmap.close()
      }
      const rgba = ctx.getImageData(0, 0, width, height).data
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', rgba))].join()
    }, { layers, width: Number(firestore.widthPx.integerValue), height: Number(firestore.heightPx.integerValue) })
    const rendered = page => canvas(page).evaluate(async element => {
      const rgba = element.getContext('2d').getImageData(0, 0, element.width, element.height).data
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', rgba))].join()
    })
    assert.equal(await rendered(b), expected)

    let uploads = 0
    a.on('request', request => { if (request.url().includes('/uploadArtworkPng?')) uploads++ })
    const rejectDownload = /\/downloadArtworkPng\?/
    await a.route(rejectDownload, request => request.abort())
    await a.goto(base)
    await button(a, '서버 작품 보기').click()
    await button(a, `${title} 열기`).click()
    await a.getByRole('alert').filter({ hasText: '서버 확정본을 불러오지 못했습니다.' }).waitFor()
    assert.equal(await a.locator('.drawcanvas').count(), 0)
    assert.deepEqual(await pixelSignatures(a), uncommittedPixels)

    await a.unroute(rejectDownload)
    await button(a, '다시 시도').click()
    await canvas(a).waitFor()
    assert.equal(new URL(a.url()).searchParams.get('view'), 'server')
    assert.equal(await a.getByLabel('현재 작품 정보').getAttribute('data-server-version'), String(version))
    assert.equal(await canvas(a).getAttribute('data-read-only'), 'true')
    assert.equal(await rendered(a), expected)
    await button(a, '레이어 패널 열기').click()
    assert.equal(await button(a, '레이어 추가').isDisabled(), true)
    const box = await canvas(a).boundingBox()
    await a.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.75)
    assert.equal(await rendered(a), expected)
    await a.reload()
    assert.equal(await rendered(a), expected)
    await a.getByText('이 브라우저의 복구 초안 (1)', { exact: true }).waitFor()
    const after = await local(a)
    assert.deepEqual(after.job, before.job)
    assert.equal(after.state.serverVersion, before.state.serverVersion)
    assert.equal(after.state.localVersion, before.state.localVersion)
    assert.deepEqual(after.drafts, before.drafts)
    assert.deepEqual(await pixelSignatures(a), uncommittedPixels)
    assert.deepEqual(await pixelSignatures(a, after.drafts[0]), uncommittedPixels)
    assert.equal(uploads, 0)
    await a.getByRole('link', { name: '이 브라우저의 작업본' }).click()
    assert.notEqual(await rendered(a), expected)
    console.log(`Version comparison: A local v${before.state.serverVersion}, Firestore and A server view v${version}`)
  })

  await check('cleanup is dry-run by default, deletes only aged terminal staging and keeps committed PNGs', async () => {
    const requestDoc = `${docs}/${artworkPath()}/saveReceipts/${stagedJob}`
    assert.equal((await call(b, 'cleanupArtworkStaging', { requestId: stagedJob, execute: true })).eligible, false)
    await http(`${requestDoc}?updateMask.fieldPaths=abandonedAt`, { method: 'PATCH', headers: { ...admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { abandonedAt: { timestampValue: '2000-01-01T00:00:00.000Z' } } }) })
    const dry = await call(b, 'cleanupArtworkStaging', { requestId: stagedJob })
    assert.ok(dry.eligible && dry.candidates > 0 && dry.deleted === 0)
    await http(`${objects}/${encodeURIComponent(stagingPath)}`, { headers: admin })
    const result = await call(b, 'cleanupArtworkStaging', { requestId: stagedJob, execute: true })
    assert.equal(result.deleted, dry.candidates)
    assert.equal((await fetch(`${objects}/${encodeURIComponent(stagingPath)}`, { headers: admin })).status, 404)
    const manifest = (await readDoc('')).layerManifest.arrayValue.values
    for (const { mapValue: { fields: layer } } of manifest) {
      if (layer.pngPath.stringValue) await http(`${objects}/${encodeURIComponent(layer.pngPath.stringValue)}`, { headers: admin })
    }
  })

  await check('server soft delete is versioned, protects local drafts and updates the other browser', async () => {
    const version = (await call(b, 'getServerArtwork')).serverVersion
    const olderProof = await proof(b)
    const localOriginals = await pixelSignatures(a)
    const draftId = (await local(a)).drafts[0]
    const draftOriginals = await pixelSignatures(a, draftId)
    const request = { expectedServerVersion: version, requestId: crypto.randomUUID() }
    await assert.rejects(call(a, 'deleteServerArtwork', request), { code: 'functions/failed-precondition' })
    await assert.rejects(call(outsider, 'deleteServerArtwork', request), { code: 'functions/not-found' })
    const blocked = await a.evaluate(async ({ uid, id, request }) => {
      try {
        await (await import('/src/services/artworkSyncService.js')).deleteRegisteredArtwork(uid, id, request.expectedServerVersion, request.requestId)
        return ''
      } catch (error) { return error.message }
    }, { uid, id, request })
    assert.match(blocked, /미동기화 작업 또는 복구 초안/)
    await button(b, '서버 저장 후 편집 종료').click()
    await button(b, '편집 세션 받기').waitFor()
    await assert.rejects(call(b, 'deleteServerArtwork', { ...request, expectedServerVersion: version - 1 }), { code: 'functions/failed-precondition' })
    const committed = (await readDoc('')).layerManifest
    await b.goto(base)
    await button(b, `${title} 관리`).click()
    b.once('dialog', dialog => dialog.accept())
    await button(b, '삭제').click()
    await b.getByText('서버에서 삭제된 작품의 로컬 보존본', { exact: true }).waitFor()
    const tombstone = await readDoc('')
    assert.equal(tombstone.state.stringValue, 'deleted')
    assert.equal(Number(tombstone.serverVersion.integerValue), version + 1)
    assert.ok(tombstone.deletedAt.timestampValue)
    assert.deepEqual(tombstone.layerManifest, committed)
    const requestId = tombstone.deletion.mapValue.fields.requestId.stringValue
    assert.deepEqual(await call(b, 'deleteServerArtwork', { expectedServerVersion: version, requestId }),
      { artworkId: id, serverVersion: version + 1 })
    await assert.rejects(call(b, 'deleteServerArtwork', request), { code: 'functions/failed-precondition' })
    await assert.rejects(call(b, 'finalizeArtworkSave', { proof: olderProof, requestId: stagedJob }), { code: 'functions/not-found' })
    await assert.rejects(call(b, 'acquireEditSession', { deviceId: 'cannot-reopen' }), { code: 'functions/not-found' })
    assert.equal(Number((await readDoc('')).serverVersion.integerValue), version + 1)
    for (const row of committed.arrayValue.values) {
      const pngPath = row.mapValue.fields.pngPath.stringValue
      if (pngPath) await http(`${objects}/${encodeURIComponent(pngPath)}`, { headers: admin })
    }
    await a.goto(base)
    await button(a, '서버 작품 보기').click()
    const recoveryList = a.getByText('서버에서 삭제된 작품의 로컬 보존본', { exact: true })
    await recoveryList.waitFor()
    assert.equal(await button(a, `${title} 열기`).count(), 0)
    await a.reload()
    await recoveryList.click()
    await a.getByRole('link', { name: title, exact: true }).click()
    assert.equal(await canvas(a).getAttribute('data-read-only'), 'true')
    assert.equal(await a.getByText('서버 동기화 완료', { exact: true }).count(), 0)
    await a.getByText('이 브라우저의 복구 초안 (1)', { exact: true }).waitFor()
    assert.deepEqual(await pixelSignatures(a), localOriginals)
    assert.deepEqual(await pixelSignatures(a, draftId), draftOriginals)
    assert.equal((await local(a)).job.state, 'quarantined')
  })

  await check('server catalog pages with tied timestamps, deduplicates cached works and isolates accounts', async () => {
    const prefix = `page-${run}-`
    const stamp = { timestampValue: '2025-01-01T00:00:00.000Z' }
    const string = stringValue => ({ stringValue })
    const ids = Array.from({ length: 45 }, (_, index) => `${prefix}${String(index).padStart(2, '0')}`)
    const fixtures = [
      ...ids.map((id, index) => [uid, id, `서버 페이지 ${String(index).padStart(2, '0')}`, 'active']),
      [uid, prefix + 'hidden', '삭제 표식 픽스처', 'deleted'],
      [users[1], prefix + 'foreign', '다른 UID 작품', 'active'],
    ]
    const writes = fixtures.map(([owner, id, name, state]) => {
      const path = `users/${owner}/artworks/${id}`
      catalogFixtures.push(path)
      return { update: { name: `projects/${project}/databases/(default)/documents/${path}`, fields: {
        ownerUid: string(owner), artworkId: string(id), title: string(name), state: string(state), publication: string('ready'),
        widthPx: { integerValue: '8' }, heightPx: { integerValue: '8' }, backgroundColor: string('#ffffff'),
        createdAt: stamp, updatedAt: stamp, serverVersion: { integerValue: '1' },
      } } }
    })
    await http(`${docs}:commit`, { method: 'POST', headers: { ...admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ writes }) })
    await a.goto(base)
    const cardSelector = `.artwork-card[data-artwork-id^="${prefix}"]`
    const cards = a.locator(cardSelector)
    const idsOnPage = () => cards.evaluateAll(items => items.map(item => item.dataset.artworkId))
    const waitCount = async count => a.waitForFunction(({ cardSelector, count }) =>
      document.querySelectorAll(cardSelector).length === count, { cardSelector, count })
    // 로컬 캐시와 같은 ID는 서버 페이지와 합쳐 카드 하나만 표시한다.
    await a.evaluate(async ({ uid, id }) => {
      const { localDb } = await import('/src/db/localDb.js')
      await localDb.artworks.add({ uid, artworkId: id, title: '로컬 캐시', titleNormalized: '로컬 캐시', width: 8, height: 8,
        state: 'active', createdAt: 10, updatedAt: 10 })
    }, { uid, id: ids[44] })
    await button(a, '서버 작품 보기').click()
    await waitCount(20)
    const firstPage = await idsOnPage()
    assert.deepEqual([...firstPage].sort(), ids.slice(-20))
    await button(a, '서버 작품 더 보기').click()
    await waitCount(40)
    await button(a, '서버 작품 더 보기').click()
    await waitCount(45)
    assert.deepEqual((await idsOnPage()).sort(), ids)
    await a.getByRole('textbox', { name: '작품 검색' }).fill('서버 페이지 00')
    await waitCount(1)
    await button(a, '서버 페이지 00 열기').waitFor()
    await a.getByRole('textbox', { name: '작품 검색' }).fill('')
    await a.getByRole('combobox', { name: '작품 정렬' }).selectOption('title')
    await waitCount(21)
    await a.reload()
    await button(a, '서버 작품 보기').click()
    await waitCount(20)
    const foreign = await outsider.evaluate(async () => {
      const { auth } = await import('/src/config/firebase.js')
      return (await (await import('/src/services/artworkSyncService.js')).listServerArtworks(auth.currentUser.uid)).rows.map(row => row.artworkId)
    })
    assert.deepEqual(foreign, [prefix + 'foreign'])
    await a.evaluate(async () => (await import('/src/services/authService.js')).logoutUser())
    await a.getByRole('link', { name: '로그인', exact: true }).waitFor()
    await account(a, `other-${email}`, false)
    await button(a, '서버 작품 보기').click()
    await waitCount(1)
    assert.deepEqual(await idsOnPage(), [prefix + 'foreign'])
  })
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await browser?.close()
  await server?.close()
  try {
    for (const path of catalogFixtures) await http(`${docs}/${path}`, { method: 'DELETE', headers: admin })
    if (uid && id) {
      const path = artworkPath()
      for (const child of ['layers', 'editSession', 'saveReceipts', 'revisions', 'sessionRecoveries']) {
        const list = await http(`${docs}/${path}/${child}`, { headers: admin })
        for (const item of (await list.json()).documents ?? []) {
          const suffix = item.name.split('/documents/')[1]
          if (suffix.startsWith(`${path}/`)) await http(`${docs}/${suffix}`, { method: 'DELETE', headers: admin })
        }
      }
      const files = await http(`${objects}?prefix=${encodeURIComponent(path + '/')}`, { headers: admin })
      for (const file of (await files.json()).items ?? []) {
        if (!file.name.startsWith(path + '/')) continue
        await http(`http://127.0.0.1:9199/v0/b/${bucket}/o/${encodeURIComponent(file.name)}`, { method: 'DELETE', headers: admin })
      }
      await http(`${docs}/${path}`, { method: 'DELETE', headers: admin })
    }
    for (const user of users) {
      await http(`${docs}/users/${user}`, { method: 'DELETE', headers: admin })
      await http(`http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/${project}/accounts:delete`,
        { method: 'POST', headers: { ...admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ localId: user }) })
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
  console.log(`5-D checks passed: ${passed}`)
}
