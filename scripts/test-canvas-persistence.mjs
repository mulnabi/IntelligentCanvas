// 실제 Edge + 로컬 Emulator + 격리된 브라우저 IndexedDB 통합 검사.
// 실행: node scripts/test-canvas-persistence.mjs
// Playwright 별도 설치 시 PLAYWRIGHT_MODULE_PATH에 index.mjs의 실제 경로 지정.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright')
const runId = crypto.randomUUID()
const outputDir = join(tmpdir(), `intelligentcanvas-png-${runId}`)
await mkdir(outputDir, { recursive: true })
const base = 'http://127.0.0.1:5188'
const password = `Canvas-${runId}!`
const emails = { a: `png-${runId}-a@example.test`, b: `png-${runId}-b@example.test` }
const results = []
const users = new Set()
const pageErrors = []
const forbiddenRequests = []
const networkErrors = []
const consoleErrors = []
let server, browser, context, page
let uidA, uidB, legacy, legacyPainted, artA, artB, userBArtwork, firstPixels, latestPixels

async function check(name, run) {
  await run()
  results.push({ name, status: 'passed' })
  console.log(JSON.stringify({ name, status: 'passed' }))
}
async function uid() {
  return page.evaluate(async () => {
    const { auth } = await import('/src/config/firebase.js')
    await auth.authStateReady()
    return auth.currentUser?.uid ?? null
  })
}
async function artwork(id, owner = uidA) {
  return page.evaluate(async ([uid, id]) => (await import('/src/db/localDb.js')).localDb.artworks.get([uid, id]), [owner, id])
}
async function layerRows(id, owner = uidA) {
  return page.evaluate(async ([uid, artworkId]) => {
    const { localDb } = await import('/src/db/localDb.js')
    return localDb.layers.where({ uid, artworkId }).sortBy('sortOrder')
  }, [owner, id])
}
async function rawContent(id, owner = uidA, layerId, legacy = false) {
  return page.evaluate(async ([uid, artworkId, layerId, legacy]) => {
    const { localDb } = await import('/src/db/localDb.js')
    const record = legacy ? await localDb.canvasContents.get([uid, artworkId])
      : await localDb.layerContents.where(layerId ? { uid, artworkId, layerId } : { uid, artworkId }).first()
    if (!record) return null
    return { uid: record.uid, artworkId: record.artworkId, width: record.width, height: record.height,
      savedAt: record.savedAt, schemaVersion: record.schemaVersion, isBlob: record.pngBlob instanceof Blob,
      type: record.pngBlob.type, size: record.pngBlob.size, pixels: await window.canvasTestPixels(record.pngBlob) }
  }, [owner, id, layerId, legacy])
}
async function pixels() {
  return page.evaluate(() => window.canvasTestPixels(document.querySelector('.drawcanvas')))
}
async function ready() {
  await page.locator('.drawcanvas').waitFor()
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.drawcanvas')
    return canvas?.dataset.ready === 'true'
  })
}
async function saved() {
  await page.getByRole('status').filter({ hasText: '이 브라우저에 저장됨' }).waitFor()
}
async function encodeMode(mode) {
  await page.evaluate(mode => {
    window.canvasTestEncoding.mode = mode
    window.canvasTestEncoding.release = null
  }, mode)
}
async function sample(x, y) {
  return page.locator('.drawcanvas').evaluate((canvas, [x, y]) =>
    [...canvas.getContext('2d').getImageData(x, y, 1, 1).data], [x, y])
}
async function compositeRgba() {
  const encoded = await page.locator('.drawcanvas').evaluate(canvas => {
    const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    return new Uint8Array(rgba.buffer).toBase64()
  })
  return Buffer.from(encoded, 'base64')
}
function assertSameTranslucentComposite(actual, expected) {
  assert.equal(actual.length, expected.length)
  let alphaDiff = 0
  let visibleColorDiff = 0
  for (let offset = 0; offset < expected.length; offset += 4) {
    const beforeAlpha = expected[offset + 3]
    const afterAlpha = actual[offset + 3]
    alphaDiff = Math.max(alphaDiff, Math.abs(beforeAlpha - afterAlpha))
    for (let channel = 0; channel < 3; channel++) {
      const before = expected[offset + channel] * beforeAlpha / 255
      const after = actual[offset + channel] * afterAlpha / 255
      visibleColorDiff = Math.max(visibleColorDiff, Math.abs(before - after))
    }
  }
  // PNG의 알파 변환 후 반투명 합성에서 8비트 반올림이 한 번 더 일어난다.
  assert.ok(alphaDiff <= 1 && visibleColorDiff <= 2, `alpha delta=${alphaDiff}; visible color delta=${visibleColorDiff}`)
}
async function openLayers() {
  await page.getByRole('button', { name: '레이어 패널 열기' }).click()
  return page.locator('.layer-panel')
}
async function chooseColor(hue) {
  await page.locator('.openColorPicker').click()
  const square = page.locator('.color-picker-square')
  const squareBox = await square.boundingBox()
  // 검정에서 색상환만 누르면 현재 RGB 값에는 색상이 아직 반영되지 않는다.
  await square.click({ position: { x: squareBox.width - 5, y: 5 } })
  const wheel = page.locator('.color-picker-wheel')
  const wheelBox = await wheel.boundingBox()
  const rad = hue * Math.PI / 180
  await wheel.click({ position: {
    x: wheelBox.width * (0.5 + 0.43 * Math.sin(rad)),
    y: wheelBox.height * (0.5 - 0.43 * Math.cos(rad)),
  } })
  await page.locator('.color-picker-header button').click()
  await page.locator('.color-picker-menu').waitFor({ state: 'hidden' })
}
async function open(id) {
  await page.goto(`${base}/drawing/${id}`)
  await ready()
}
async function create(title, width = 800, height = 800) {
  await page.goto(base)
  await page.getByRole('button', { name: '+ 새 작품', exact: true }).click()
  await page.locator('#new-artwork-title').fill(title)
  await page.getByLabel('가로 픽셀').fill(String(width))
  await page.getByLabel('세로 픽셀').fill(String(height))
  await page.getByRole('button', { name: '확인', exact: true }).click()
  await page.getByRole('dialog', { name: '새 작품', exact: true }).waitFor({ state: 'hidden' })
  return page.evaluate(async title => {
    const { auth } = await import('/src/config/firebase.js')
    const rows = await (await import('/src/repositories/artworkRepository.js')).listArtworks(auth.currentUser.uid)
    return rows.find(row => row.title === title)
  }, title)
}
async function stroke(points, { finish = true } = {}) {
  const { box, width, height } = await page.locator('.drawcanvas').evaluate(canvas => {
    const rect = canvas.getBoundingClientRect()
    return { box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, width: canvas.width, height: canvas.height }
  })
  const screen = ([x, y]) => [box.x + x / width * box.width, box.y + y / height * box.height]
  await page.mouse.move(...screen(points[0]))
  await page.mouse.down()
  for (const point of points.slice(1)) await page.mouse.move(...screen(point), { steps: 6 })
  if (finish) await page.mouse.up()
}
async function logout() {
  await page.evaluate(async () => (await import('/src/services/authService.js')).logoutUser())
  assert.equal(await uid(), null)
}
async function login(email) {
  await page.goto(`${base}/login`)
  await page.locator('#login-email').fill(email)
  await page.locator('#login-password').fill(password)
  await page.waitForFunction(() => !document.querySelector('button[type=submit]').disabled)
  await page.locator('button[type=submit]').click()
  await page.waitForURL(`${base}/`)
}

try {
  const hub = await (await fetch('http://127.0.0.1:4400/emulators')).json()
  assert.equal(hub.auth.port, 9099)
  assert.equal(hub.firestore.port, 8080)
  server = await createServer({ server: { host: '127.0.0.1', port: 5188, strictPort: true }, logLevel: 'error' })
  await server.listen()
  browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'msedge', headless: true })
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  // 격리된 테스트 출처에서만 로컬 Emulator 접근을 허용한다.
  await context.grantPermissions(['local-network-access'], { origin: base })
  await context.route('**/*', route => {
    const request = route.request()
    const url = new URL(request.url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
      forbiddenRequests.push(url.origin)
      return route.abort()
    }
    if (url.pathname === '/__canvas-fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated migration fixture</title>' })
    const payload = request.postData() || url.pathname
    if (url.port === '8080' && (/editSession|revisions/.test(payload)
      || (/artworks/.test(payload) && !/\/Listen\/channel$/.test(url.pathname)))) forbiddenRequests.push('server-artwork-request')
    if (!['5188', '9099', '8080'].includes(url.port)) forbiddenRequests.push(url.origin)
    return route.continue()
  })
  await context.addInitScript(() => {
    const nativeToBlob = HTMLCanvasElement.prototype.toBlob
    const encoding = window.canvasTestEncoding = { mode: 'normal', release: null, calls: 0 }
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      encoding.calls++
      if (encoding.mode === 'fail') { callback(null); return }
      if (encoding.mode === 'pause-once') {
        encoding.mode = 'normal'
        nativeToBlob.call(this, blob => { encoding.release = () => callback(blob) }, ...args)
        return
      }
      nativeToBlob.call(this, callback, ...args)
    }
    const NativeImage = window.Image
    const imageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
    window.Image = function (...args) {
      const image = new NativeImage(...args)
      if (sessionStorage.getItem('delayCanvasRestore') === 'true') {
        Object.defineProperty(image, 'src', {
          configurable: true,
          get() { return imageSrc.get.call(image) },
          set(value) {
            if (String(value).startsWith('blob:')) window.releaseCanvasRestore = () => imageSrc.set.call(image, value)
            else imageSrc.set.call(image, value)
          },
        })
      }
      return image
    }
    window.Image.prototype = NativeImage.prototype
    const createUrl = URL.createObjectURL.bind(URL)
    const revokeUrl = URL.revokeObjectURL.bind(URL)
    window.canvasTestUrls = new Set()
    URL.createObjectURL = value => {
      const url = createUrl(value)
      window.canvasTestUrls.add(url)
      return url
    }
    URL.revokeObjectURL = url => { window.canvasTestUrls.delete(url); revokeUrl(url) }
    // Blob의 존재만 검사하지 않고 디코딩한 전체 RGBA 바이트를 SHA-256으로 비교한다.
    window.canvasTestPixels = async source => {
      let canvas = source
      if (source instanceof Blob) {
        const bitmap = await createImageBitmap(source)
        canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        canvas.getContext('2d').drawImage(bitmap, 0, 0)
        bitmap.close()
      }
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      let opaque = 0
      for (let i = 3; i < data.length; i += 4) if (data[i]) opaque++
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
      return { width: canvas.width, height: canvas.height, opaque,
        hash: [...digest].map(n => n.toString(16).padStart(2, '0')).join('') }
    }
  })
  context.on('page', opened => {
    opened.on('pageerror', error => pageErrors.push(error.message))
    opened.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text().replace(/(?:https?|wss?):\/\/[^\s'"<>]+/g, value => {
        try { const url = new URL(value); return url.origin + url.pathname } catch { return '[URL]' }
      }))
    })
  })
  context.on('requestfailed', request => {
    const url = new URL(request.url())
    networkErrors.push({ path: url.origin + url.pathname, error: request.failure()?.errorText })
  })
  page = await context.newPage()
  page.setDefaultTimeout(15000)

  await check('v1_metadata_and_v2_PNG_fixtures_survive_v3_upgrade', async () => {
    await page.goto(`${base}/__canvas-fixture`)
    uidA = await page.evaluate(async ({ email, password }) => {
      const { user } = await (await import('/src/services/authService.js')).registerUser({ username: '그림친구', email, password })
      return user.uid
    }, { email: emails.a, password })
    users.add(uidA)
    legacy = { uid: uidA, artworkId: crypto.randomUUID(), title: '이전 버전 작품', titleNormalized: '이전 버전 작품',
      width: 800, height: 800, backgroundColor: '#ffffff', createdAt: 1234567890, updatedAt: 1234567890,
      schemaVersion: 1, state: 'active', deletedAt: null }
    legacyPainted = { ...legacy, artworkId: crypto.randomUUID(), title: '이전 버전 그림', titleNormalized: '이전 버전 그림' }
    await page.evaluate(async ({ legacy, legacyPainted }) => {
      const known = await indexedDB.databases()
      if (known.some(db => db.name === 'IntelligentCanvasLocal')) throw new Error('Expected empty isolated test context; refusing to replace any DB')
      // Dexie는 논리 버전 1을 native IndexedDB 버전 10으로 사용한다.
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('IntelligentCanvasLocal', 10)
        request.onupgradeneeded = () => {
          const table = request.result.createObjectStore('artworks', { keyPath: ['uid', 'artworkId'] })
          table.createIndex('[uid+state+updatedAt]', ['uid', 'state', 'updatedAt'])
          table.createIndex('[uid+state+createdAt]', ['uid', 'state', 'createdAt'])
          table.put(legacy)
          table.put({ ...legacy, artworkId: 'deleted-fixture', title: '기존 삭제 기록', state: 'deleted', deletedAt: 1234567900 })
        }
        request.onsuccess = () => { request.result.close(); resolve() }
        request.onerror = () => reject(request.error)
      })
      const source = document.createElement('canvas')
      source.width = 800
      source.height = 800
      const context = source.getContext('2d')
      context.fillStyle = 'rgba(243,78,131,0.67)'
      context.fillRect(42, 60, 100, 100)
      context.fillStyle = '#2255ae'
      context.fillRect(55, 78, 70, 120)
      const pngBlob = await new Promise(resolve => source.toBlob(resolve, 'image/png'))
      // 제품을 열기 전에 native v20으로 올려 이전 버전 DB를 실제로 준비한다.
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('IntelligentCanvasLocal', 20)
        request.onupgradeneeded = () => {
          const table = request.result.createObjectStore('canvasContents', { keyPath: ['uid', 'artworkId'] })
          request.transaction.objectStore('artworks').put(legacyPainted)
          table.put({ uid: legacyPainted.uid, artworkId: legacyPainted.artworkId, pngBlob, width: 800, height: 800,
            savedAt: 1234567890, schemaVersion: 1 })
        }
        request.onsuccess = () => { request.result.close(); resolve() }
        request.onerror = () => reject(request.error)
      })
    }, { legacy, legacyPainted })
    await page.goto(base)
    await page.getByRole('button', { name: '이전 버전 작품 열기', exact: true }).waitFor()
    const state = await page.evaluate(async () => {
      const { localDb } = await import('/src/db/localDb.js')
      return { version: localDb.verno, tables: localDb.tables.map(t => t.name).sort(), count: await localDb.artworks.count() }
    })
    assert.deepEqual(state, { version: 5, tables: ['artworkSync', 'artworks', 'canvasContents', 'layerContents', 'layers', 'recoveryDrafts', 'syncQueue'], count: 3 })
    assert.deepEqual(await artwork(legacy.artworkId), legacy)
    await open(legacy.artworkId)
    assert.equal((await pixels()).opaque, 0)
    assert.equal(await rawContent(legacy.artworkId), null)
    assert.equal((await layerRows(legacy.artworkId)).length, 1)
    assert.deepEqual(await artwork(legacy.artworkId), legacy)
  })
  await check('v2_migration_rolls_back_and_retry_restores_identical_pixels_once', async () => {
    await page.getByRole('link', { name: '작품 목록', exact: true }).click()
    const original = await rawContent(legacyPainted.artworkId, uidA, null, true)
    assert.ok(original.pixels.opaque > 0)
    await page.evaluate(async () => {
      const { localDb } = await import('/src/db/localDb.js')
      window.failMigration = () => { throw new DOMException('test migration quota', 'QuotaExceededError') }
      localDb.layerContents.hook('creating', window.failMigration)
    })
    await page.getByRole('button', { name: '이전 버전 그림 열기', exact: true }).click()
    await page.getByRole('alert').waitFor()
    assert.equal((await layerRows(legacyPainted.artworkId)).length, 0)
    assert.equal(await rawContent(legacyPainted.artworkId), null)
    assert.deepEqual(await rawContent(legacyPainted.artworkId, uidA, null, true), original)
    await page.evaluate(async () => (await import('/src/db/localDb.js')).localDb.layerContents.hook('creating').unsubscribe(window.failMigration))
    await page.getByRole('button', { name: '다시 불러오기', exact: true }).click()
    await ready()
    assert.deepEqual(await pixels(), original.pixels)
    const rows = await layerRows(legacyPainted.artworkId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].name, '기존 그림')
    assert.equal(rows[0].visible, true)
    assert.equal(rows[0].opacity, 1)
    assert.deepEqual(await rawContent(legacyPainted.artworkId), original)
    await page.reload()
    await ready()
    assert.deepEqual(await pixels(), original.pixels)
    await page.getByRole('link', { name: '작품 목록', exact: true }).click()
    await page.getByRole('button', { name: '이전 버전 그림 열기', exact: true }).click()
    await ready()
    assert.deepEqual(await pixels(), original.pixels)
    assert.deepEqual(await layerRows(legacyPainted.artworkId), rows)
    assert.deepEqual(await artwork(legacyPainted.artworkId), legacyPainted)
  })
  await check('existing_login_and_profile_survive_upgrade', async () => {
    await logout()
    await login(emails.a)
    assert.equal(await uid(), uidA)
    const profile = await page.evaluate(async uid => (await import('/src/services/userService.js')).getUserProfile(uid), uidA)
    assert.equal(profile.uid, uidA)
    assert.equal(profile.nickname, '그림친구')
  })
  await check('new_1024x768_artwork_opens_blank_at_actual_resolution', async () => {
    artA = await create('PNG A', 1024, 768)
    await page.getByRole('button', { name: 'PNG A 열기', exact: true }).click()
    await page.waitForURL(`${base}/drawing/${artA.artworkId}`)
    await ready()
    assert.deepEqual(await pixels(), { width: 1024, height: 768, opaque: 0, hash: (await pixels()).hash })
    assert.equal(await rawContent(artA.artworkId), null)
  })
  await check('pen_autosave_stores_binary_PNG_and_atomic_updatedAt', async () => {
    await stroke([[250, 250], [500, 250], [500, 400]])
    firstPixels = await pixels()
    assert.ok(firstPixels.opaque > 300)
    await saved()
    const content = await rawContent(artA.artworkId)
    assert.equal(content.isBlob, true)
    assert.equal(content.type, 'image/png')
    assert.ok(content.size > 0)
    assert.equal(content.width, 1024)
    assert.equal(content.height, 768)
    assert.equal(content.uid, uidA)
    assert.equal(content.artworkId, artA.artworkId)
    assert.equal(content.schemaVersion, 1)
    assert.deepEqual(content.pixels, firstPixels)
    const metadata = await artwork(artA.artworkId)
    assert.equal(metadata.updatedAt, content.savedAt)
    assert.equal(metadata.createdAt, artA.createdAt)
  })
  await check('list_reopen_and_F5_restore_identical_RGBA_pixels', async () => {
    const content = await rawContent(artA.artworkId)
    await page.getByRole('link', { name: '작품 목록', exact: true }).click()
    await page.waitForURL(`${base}/`)
    await page.getByRole('button', { name: 'PNG A 열기', exact: true }).click()
    await ready()
    assert.deepEqual(await pixels(), firstPixels)
    assert.equal((await rawContent(artA.artworkId)).savedAt, content.savedAt)
    await page.reload()
    await ready()
    assert.deepEqual(await pixels(), firstPixels)
    assert.equal((await rawContent(artA.artworkId)).savedAt, content.savedAt)
  })
  await check('restore_blocks_pointer_input_and_releases_object_URL', async () => {
    const before = await rawContent(artA.artworkId)
    await page.evaluate(() => sessionStorage.setItem('delayCanvasRestore', 'true'))
    await page.reload()
    await page.waitForFunction(() => typeof window.releaseCanvasRestore === 'function')
    assert.notEqual(await page.locator('.drawcanvas').getAttribute('data-ready'), 'true')
    await stroke([[150, 150], [250, 150]])
    assert.equal((await pixels()).opaque, 0)
    assert.equal((await rawContent(artA.artworkId)).savedAt, before.savedAt)
    await page.evaluate(() => { sessionStorage.removeItem('delayCanvasRestore'); window.releaseCanvasRestore() })
    await ready()
    assert.deepEqual(await pixels(), firstPixels)
    assert.equal(await page.evaluate(() => window.canvasTestUrls.size), 0)
  })
  await check('additional_stroke_and_eraser_persist_exactly', async () => {
    await stroke([[600, 500], [800, 550]])
    await saved()
    const added = await pixels()
    assert.ok(added.opaque > firstPixels.opaque)
    await page.locator('label[for=eraser]').click()
    await stroke([[350, 230], [350, 270]])
    await saved()
    latestPixels = await pixels()
    assert.ok(latestPixels.opaque < added.opaque)
    assert.notEqual(latestPixels.hash, added.hash)
    assert.deepEqual((await rawContent(artA.artworkId)).pixels, latestPixels)
    await page.reload()
    await ready()
    assert.deepEqual(await pixels(), latestPixels)
  })
  await check('zoom_changes_display_only_and_preserves_pixel_coordinates', async () => {
    const before = await page.locator('.drawcanvas').boundingBox()
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
    await page.mouse.wheel(0, 240)
    await page.waitForFunction(width => document.querySelector('.drawcanvas').getBoundingClientRect().width !== width, before.width)
    const unchanged = await pixels()
    assert.deepEqual(unchanged, latestPixels)
    await stroke([[100, 100], [220, 100]])
    await saved()
    latestPixels = await pixels()
    assert.equal(latestPixels.width, 1024)
    assert.equal(latestPixels.height, 768)
    assert.deepEqual((await rawContent(artA.artworkId)).pixels, latestPixels)
    const point = await page.locator('.drawcanvas').evaluate(c => [...c.getContext('2d').getImageData(160, 100, 1, 1).data])
    assert.ok(point[3] > 0)
  })
  await check('color_picker_and_non_drawing_rerenders_preserve_pixels', async () => {
    const savedBefore = await rawContent(artA.artworkId)
    await page.locator('.openColorPicker').click()
    const pickerSquare = page.locator('.color-picker-square')
    const square = await pickerSquare.boundingBox()
    // 둥근 모서리 바깥은 색상환에 속한다. 채도/명도 사각형 내부를 누른다.
    await pickerSquare.click({ position: { x: square.width - 5, y: 5 } })
    await page.locator('.color-picker-header button').click()
    await page.locator('.color-picker-menu').waitFor({ state: 'hidden' })
    assert.deepEqual(await pixels(), latestPixels)
    assert.equal((await rawContent(artA.artworkId)).savedAt, savedBefore.savedAt)
    await stroke([[650, 150], [800, 150]])
    await saved()
    const red = await page.locator('.drawcanvas').evaluate(c => [...c.getContext('2d').getImageData(720, 150, 1, 1).data])
    assert.ok(red[0] > 220 && red[1] < 20 && red[2] < 20 && red[3] > 0, `Expected red stroke, got RGBA ${red}`)
    latestPixels = await pixels()
    await page.evaluate(async ({ uid, id }) => (await import('/src/repositories/artworkRepository.js')).renameArtwork(uid, id, 'PNG A 이름 변경'), { uid: uidA, id: artA.artworkId })
    await page.getByText('PNG A 이름 변경', { exact: true }).waitFor()
    assert.deepEqual(await pixels(), latestPixels)
  })
  await check('selection_and_eraser_on_empty_pixels_do_not_create_saves', async () => {
    const before = await rawContent(artA.artworkId)
    await page.locator('label[for=select]').click()
    await stroke([[50, 50], [100, 50]])
    await page.locator('label[for=eraser]').click()
    await stroke([[30, 30], [80, 30]])
    await page.waitForTimeout(450)
    assert.deepEqual(await pixels(), latestPixels)
    assert.equal((await rawContent(artA.artworkId)).savedAt, before.savedAt)
    await page.locator('label[for=pen]').click()
  })
  await check('queued_save_keeps_edits_made_during_PNG_encoding', async () => {
    await encodeMode('pause-once')
    await stroke([[150, 600], [300, 600]])
    await page.waitForFunction(() => typeof window.canvasTestEncoding.release === 'function')
    await stroke([[400, 620], [550, 620]])
    const expected = await pixels()
    await page.evaluate(() => window.canvasTestEncoding.release())
    await saved()
    assert.deepEqual((await rawContent(artA.artworkId)).pixels, expected)
    latestPixels = expected
  })
  await check('pointer_release_outside_canvas_and_pointer_cancel_save', async () => {
    await stroke([[950, 650], [1080, 650]])
    await saved()
    assert.deepEqual((await rawContent(artA.artworkId)).pixels, await pixels())
    await stroke([[200, 450], [350, 450]], { finish: false })
    await page.locator('.drawcanvas').dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true })
    await page.mouse.up()
    await saved()
    latestPixels = await pixels()
    assert.deepEqual((await rawContent(artA.artworkId)).pixels, latestPixels)
  })
  await check('toBlob_failure_is_not_success_and_retry_preserves_edits', async () => {
    const before = await rawContent(artA.artworkId)
    await encodeMode('fail')
    await stroke([[650, 650], [800, 650]])
    await page.getByRole('alert').waitFor()
    assert.equal(await page.getByRole('status').filter({ hasText: '이 브라우저에 저장됨' }).count(), 0)
    assert.equal((await rawContent(artA.artworkId)).savedAt, before.savedAt)
    const expected = await pixels()
    await encodeMode('normal')
    await page.getByRole('button', { name: '다시 저장', exact: true }).click()
    await saved()
    assert.deepEqual((await rawContent(artA.artworkId)).pixels, expected)
    latestPixels = expected
  })
  await check('transaction_failure_rolls_back_PNG_and_metadata_then_retries', async () => {
    const before = await rawContent(artA.artworkId)
    const beforeMetadata = await artwork(artA.artworkId)
    await page.evaluate(async () => {
      const { localDb } = await import('/src/db/localDb.js')
      window.failCanvasMetadata = () => { throw new DOMException('test quota', 'QuotaExceededError') }
      localDb.artworks.hook('updating', window.failCanvasMetadata)
    })
    await stroke([[100, 700], [300, 700]])
    await page.getByRole('alert').waitFor()
    assert.equal((await rawContent(artA.artworkId)).savedAt, before.savedAt)
    assert.deepEqual((await rawContent(artA.artworkId)).pixels, before.pixels)
    assert.deepEqual(await artwork(artA.artworkId), beforeMetadata)
    const expected = await pixels()
    await page.evaluate(async () => (await import('/src/db/localDb.js')).localDb.artworks.hook('updating').unsubscribe(window.failCanvasMetadata))
    await page.getByRole('button', { name: '다시 저장', exact: true }).click()
    await saved()
    assert.deepEqual((await rawContent(artA.artworkId)).pixels, expected)
    latestPixels = expected
  })
  await check('immediate_list_navigation_flushes_pending_changes', async () => {
    await stroke([[650, 350], [800, 350]])
    latestPixels = await pixels()
    await page.getByRole('link', { name: '작품 목록', exact: true }).click()
    await page.waitForURL(`${base}/`)
    assert.deepEqual((await rawContent(artA.artworkId)).pixels, latestPixels)
    await open(artA.artworkId)
    assert.deepEqual(await pixels(), latestPixels)
  })
  await check('failed_navigation_keeps_pixels_until_save_retry_succeeds', async () => {
    const previous = await rawContent(artA.artworkId)
    await encodeMode('fail')
    await stroke([[400, 500], [500, 550]])
    const expected = await pixels()
    await page.getByRole('link', { name: '작품 목록', exact: true }).click()
    await page.getByRole('alert').first().waitFor()
    assert.equal(page.url(), `${base}/drawing/${artA.artworkId}`)
    assert.deepEqual(await pixels(), expected)
    assert.deepEqual((await rawContent(artA.artworkId)).pixels, previous.pixels)
    await encodeMode('normal')
    await page.getByRole('button', { name: '다시 저장', exact: true }).click()
    await page.waitForURL(`${base}/`)
    assert.deepEqual((await rawContent(artA.artworkId)).pixels, expected)
    latestPixels = expected
    await page.getByRole('button', { name: 'PNG A 이름 변경 열기', exact: true }).click()
    await ready()
  })
  await check('browser_back_waits_for_pending_save', async () => {
    await stroke([[850, 300], [900, 400]])
    const expected = await pixels()
    // 실제 브라우저 history.back으로 Router의 POP 이동을 검증한다.
    await page.evaluate(() => history.back())
    // POP은 Router가 보류하기 전 주소창부터 바뀐다. 실제 목록 마운트를 기다린다.
    await page.getByRole('button', { name: 'PNG A 이름 변경 열기', exact: true }).waitFor()
    await page.waitForURL(`${base}/`)
    assert.deepEqual((await rawContent(artA.artworkId)).pixels, expected)
    latestPixels = expected
  })
  await check('browser_forward_restores_pixels_saved_before_back', async () => {
    await page.evaluate(() => history.forward())
    await page.waitForURL(`${base}/drawing/${artA.artworkId}`)
    await ready()
    assert.deepEqual(await pixels(), latestPixels)
  })
  await check('logout_flushes_pending_stroke_before_changing_UID', async () => {
    await stroke([[850, 500], [900, 550]])
    const expected = await pixels()
    await logout()
    await page.getByRole('link', { name: '로그인', exact: true }).waitFor()
    assert.equal(await page.locator('.drawcanvas').count(), 0)
    assert.deepEqual((await rawContent(artA.artworkId)).pixels, expected)
    latestPixels = expected
    await login(emails.a)
    await open(artA.artworkId)
    assert.deepEqual(await pixels(), expected)
  })
  await check('separate_artworks_start_blank_and_do_not_mix_pixels', async () => {
    artB = await create('PNG B', 1920, 1080)
    await open(artB.artworkId)
    assert.equal((await pixels()).opaque, 0)
    assert.equal((await pixels()).width, 1920)
    assert.equal((await pixels()).height, 1080)
    await stroke([[900, 500], [1100, 600]])
    await saved()
    const bPixels = await pixels()
    assert.notEqual(bPixels.hash, latestPixels.hash)
    await open(artA.artworkId)
    assert.deepEqual(await pixels(), latestPixels)
    await open(artB.artworkId)
    assert.deepEqual(await pixels(), bPixels)
    assert.deepEqual((await rawContent(artA.artworkId)).pixels, latestPixels)
  })
  await check('corrupt_PNG_restore_blocks_drawing_and_does_not_overwrite', async () => {
    const broken = await create('복원 오류 검사')
    // 유효한 PNG 헤더만 보존하고 이미지 본문을 자른다. Repository 헤더 검사가
    // 아니라 실제 이미지 디코더 실패 경로에서 입력 차단/파일 보존을 확인한다.
    await page.evaluate(async ({ uid, id }) => {
      const source = document.createElement('canvas')
      source.width = 800
      source.height = 800
      const full = await new Promise(resolve => source.toBlob(resolve, 'image/png'))
      await (await import('/src/db/localDb.js')).localDb.canvasContents.put({
        uid, artworkId: id, pngBlob: full.slice(0, 33, 'image/png'), width: 800, height: 800, savedAt: 1234, schemaVersion: 1,
      })
    }, { uid: uidA, id: broken.artworkId })
    await page.goto(`${base}/drawing/${broken.artworkId}`)
    await page.getByRole('alert').waitFor()
    const state = await page.evaluate(async ({ uid, id }) => {
      const record = await (await import('/src/db/localDb.js')).localDb.canvasContents.get([uid, id])
      return { ready: document.querySelector('.drawcanvas')?.dataset.ready, savedAt: record.savedAt, size: record.pngBlob.size }
    }, { uid: uidA, id: broken.artworkId })
    assert.notEqual(state.ready, 'true')
    assert.equal(state.savedAt, 1234)
    assert.equal(state.size, 33)
    assert.equal((await layerRows(broken.artworkId)).length, 0)
    assert.equal(await page.evaluate(() => window.canvasTestUrls.size), 0)
    await page.goto(base)
  })
  await check('oversized_canvas_is_not_allocated_and_metadata_is_preserved', async () => {
    const large = await create('큰 작품 검사', 8192, 8192)
    await page.goto(`${base}/drawing/${large.artworkId}`)
    await page.getByRole('alert').first().waitFor()
    assert.match(await page.getByRole('alert').first().innerText(), /16,777,216/)
    const actual = await page.locator('.drawcanvas').evaluate(canvas => ({ width: canvas.width, height: canvas.height, ready: canvas.dataset.ready }))
    assert.ok(actual.width * actual.height <= 16_777_216)
    assert.notEqual(actual.ready, 'true')
    assert.deepEqual(await artwork(large.artworkId), large)
    assert.equal(await rawContent(large.artworkId), null)
    await page.goto(base)
  })
  await check('soft_delete_preserves_PNG_but_blocks_app_content_access', async () => {
    const before = await rawContent(artB.artworkId)
    await page.evaluate(async ({ uid, id }) => (await import('/src/repositories/artworkRepository.js')).deleteArtwork(uid, id), { uid: uidA, id: artB.artworkId })
    const denied = await page.evaluate(async ({ uid, id }) => {
      try {
        const { openLayerDocument } = await import('/src/repositories/layerRepository.js')
        await openLayerDocument(uid, id, { prepare: () => {}, signal: new AbortController().signal })
        return false
      } catch { return true }
    }, { uid: uidA, id: artB.artworkId })
    assert.equal(denied, true)
    assert.deepEqual(await rawContent(artB.artworkId), before)
    await page.goto(`${base}/drawing/${artB.artworkId}`)
    await page.getByRole('alert').waitFor()
    assert.equal(await page.locator('.drawcanvas').count(), 0)
  })
  await check('logout_clears_pixels_without_deleting_local_content', async () => {
    await open(artA.artworkId)
    await logout()
    await page.getByRole('link', { name: '로그인', exact: true }).waitFor()
    assert.equal(await page.locator('.drawcanvas').count(), 0)
    assert.deepEqual((await rawContent(artA.artworkId)).pixels, latestPixels)
  })
  await check('B_signup_same_nickname_and_own_PNG_are_independent', async () => {
    await page.goto(`${base}/signup`)
    await page.locator('#signup-username').fill('그림친구')
    await page.locator('#signup-email').fill(emails.b)
    await page.locator('#signup-password').fill(password)
    await page.locator('#signup-confirm-password').fill(password)
    await page.waitForFunction(() => !document.querySelector('button[type=submit]').disabled)
    await page.locator('button[type=submit]').click()
    await page.waitForURL(`${base}/`)
    uidB = await uid()
    users.add(uidB)
    assert.notEqual(uidA, uidB)
    assert.equal(await page.locator('.artwork-card').count(), 0)
    userBArtwork = await create('B 사용자 그림')
    await open(userBArtwork.artworkId)
    assert.equal((await pixels()).opaque, 0)
    await stroke([[350, 350], [500, 500]])
    await saved()
    const bPixels = await pixels()
    assert.deepEqual((await rawContent(userBArtwork.artworkId, uidB)).pixels, bPixels)
    assert.deepEqual((await rawContent(artA.artworkId)).pixels, latestPixels)
  })
  await check('other_UID_direct_route_and_forged_content_API_are_denied', async () => {
    await page.goto(`${base}/drawing/${artA.artworkId}`)
    await page.getByRole('alert').waitFor()
    assert.equal(await page.locator('.drawcanvas').count(), 0)
    const denied = await page.evaluate(async ({ uidA, uidB, id, ownId }) => {
      const r = await import('/src/repositories/layerRepository.js')
      const { localDb } = await import('/src/db/localDb.js')
      const original = await localDb.layerContents.where({ uid: uidA, artworkId: id }).first()
      const own = await localDb.layers.where({ uid: uidB, artworkId: ownId }).first()
      const options = { prepare: () => {}, signal: new AbortController().signal }
      const input = { previousIds: [original.layerId], contents: [original] }
      return Promise.all([
        () => r.openLayerDocument(uidB, id, options), () => r.openLayerDocument(uidA, id, options),
        () => r.saveLayerChanges(uidB, id, input), () => r.saveLayerChanges(uidA, id, input),
        () => r.saveLayerChanges(uidB, ownId, { ...input, previousIds: [own.layerId] }),
      ].map(async fn => { try { await fn(); return 'ALLOWED' } catch (error) { return error.code || error.name } }))
    }, { uidA, uidB, id: artA.artworkId, ownId: userBArtwork.artworkId })
    assert.ok(denied.every(result => result !== 'ALLOWED'))
    assert.deepEqual((await rawContent(artA.artworkId)).pixels, latestPixels)
  })
  await check('A_relogin_and_refresh_restore_own_pixels_again', async () => {
    await logout()
    await login(emails.a)
    assert.equal(await uid(), uidA)
    await open(artA.artworkId)
    assert.deepEqual(await pixels(), latestPixels)
    await page.reload()
    await ready()
    assert.deepEqual(await pixels(), latestPixels)
    await page.screenshot({ path: join(outputDir, 'restored-canvas.png'), animations: 'disabled' })
  })
  let layered, blueId, redId, blue, red, blueOriginal, redOriginal
  await check('two_layer_pixels_are_independent_and_eraser_reveals_lower_stroke', async () => {
    layered = await create('두 레이어', 800, 800)
    await open(layered.artworkId)
    await chooseColor(240)
    await stroke([[290, 300], [500, 300]])
    await saved()
    blue = await sample(390, 300)
    assert.ok(blue[2] > 220 && blue[0] < 20 && blue[1] < 20 && blue[3] === 255, `Blue RGBA: ${blue}`)
    blueId = (await layerRows(layered.artworkId))[0].layerId
    blueOriginal = await rawContent(layered.artworkId, uidA, blueId)

    const panel = await openLayers()
    assert.equal(await panel.getByRole('button', { name: '레이어 삭제' }).isDisabled(), true)
    await panel.getByRole('button', { name: '레이어 추가' }).click()
    await saved()
    const layers = await layerRows(layered.artworkId)
    assert.equal(layers.length, 2)
    redId = layers[0].layerId
    assert.notEqual(redId, blueId)
    assert.equal(await rawContent(layered.artworkId, uidA, redId), null)
    assert.deepEqual(await sample(390, 300), blue)
    await chooseColor(0)
    await stroke([[290, 300], [500, 300]])
    await saved()
    red = await sample(390, 300)
    assert.ok(red[0] > 220 && red[1] < 20 && red[2] < 20 && red[3] === 255, `Red RGBA: ${red}`)
    assert.deepEqual(await rawContent(layered.artworkId, uidA, blueId), blueOriginal)
    await page.locator('label[for=eraser]').click()
    await stroke([[390, 280], [390, 320]])
    await saved()
    assert.deepEqual(await sample(390, 300), blue)
    assert.deepEqual(await rawContent(layered.artworkId, uidA, blueId), blueOriginal)
    assert.notEqual((await rawContent(layered.artworkId, uidA, redId)).pixels.hash, blueOriginal.pixels.hash)
    await page.locator('label[for=pen]').click()
    await stroke([[340, 300], [440, 300]])
    await saved()
    assert.deepEqual(await sample(390, 300), red)
    redOriginal = await rawContent(layered.artworkId, uidA, redId)
  })
  await check('visibility_opacity_and_order_persist_without_reencoding_originals', async () => {
    const panel = page.locator('.layer-panel')
    const upper = panel.locator('.layer-row').first()
    const eye = upper.locator('.layer-eye')
    const calls = await page.evaluate(() => window.canvasTestEncoding.calls)
    await eye.click()
    await saved()
    await page.getByRole('status').filter({ hasText: '선택한 레이어가 숨겨져 있습니다' }).waitFor()
    assert.deepEqual(await sample(390, 300), blue)
    const hiddenPixels = await pixels()
    await stroke([[250, 220], [460, 220]])
    assert.deepEqual(await pixels(), hiddenPixels)
    await eye.click()
    await saved()
    await panel.getByLabel('불투명도').fill('50')
    await saved()
    const mixed = await sample(390, 300)
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(Math.abs(mixed[channel] - (blue[channel] + red[channel]) / 2) <= 2, `Mixed RGBA: ${mixed}`)
    }
    assert.equal(mixed[3], 255)
    assert.deepEqual(await rawContent(layered.artworkId, uidA, redId), redOriginal)

    const row = await upper.locator('.layer-grip').boundingBox()
    await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2)
    await page.mouse.down()
    await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2 + 56, { steps: 10 })
    await page.mouse.up()
    await saved()
    assert.deepEqual(await sample(390, 300), blue)
    assert.equal(await page.evaluate(() => window.canvasTestEncoding.calls), calls)
    await panel.locator('.layer-row').first().locator('.layer-eye').click()
    await saved()
    const expected = await compositeRgba()
    const layers = await layerRows(layered.artworkId)
    assert.deepEqual(layers.map(({ layerId, sortOrder, visible, opacity }) => ({ layerId, sortOrder, visible, opacity })), [
      { layerId: blueId, sortOrder: 0, visible: false, opacity: 1 },
      { layerId: redId, sortOrder: 1, visible: true, opacity: 0.5 },
    ])
    await page.getByRole('link', { name: '작품 목록', exact: true }).click()
    await page.getByRole('button', { name: '두 레이어 열기', exact: true }).click()
    await ready()
    assertSameTranslucentComposite(await compositeRgba(), expected)
    const reopened = await pixels()
    await page.reload()
    await ready()
    assert.deepEqual(await pixels(), reopened)
    assert.deepEqual(await layerRows(layered.artworkId), layers)
    assert.deepEqual(await rawContent(layered.artworkId, uidA, blueId), blueOriginal)
    assert.deepEqual(await rawContent(layered.artworkId, uidA, redId), redOriginal)

    const restoredPanel = await openLayers()
    await restoredPanel.locator('.layer-row').first().locator('.layer-eye').click()
    await restoredPanel.locator('.layer-row').last().locator('.layer-select').click()
    await restoredPanel.getByLabel('불투명도').fill('100')
    await saved()
    assert.deepEqual(await rawContent(layered.artworkId, uidA, redId), redOriginal)
  })
  await check('stroke_target_stays_fixed_and_parallel_layer_edits_save_latest_pixels', async () => {
    const panel = page.locator('.layer-panel')
    const row = panel.locator('.layer-row')
    await row.first().locator('.layer-select').click()
    await encodeMode('pause-once')
    await stroke([[300, 510], [350, 510]], { finish: false })
    // 실제 포인터가 캡처된 동안 레이어 선택만 바꾼다.
    await row.last().locator('.layer-select').evaluate(button => button.click())
    const box = await page.locator('.drawcanvas').boundingBox()
    await page.mouse.move(box.x + box.width * 0.56, box.y + box.height * 510 / 800, { steps: 8 })
    await page.mouse.up()
    await page.waitForFunction(() => typeof window.canvasTestEncoding.release === 'function')
    await stroke([[290, 630], [500, 630]])
    const expected = await pixels()
    await page.evaluate(() => window.canvasTestEncoding.release())
    await saved()
    const alpha = await page.evaluate(async ([uid, artworkId, blueId, redId]) => {
      const { localDb } = await import('/src/db/localDb.js')
      const samples = []
      for (const layerId of [blueId, redId]) {
        const { pngBlob } = await localDb.layerContents.get([uid, artworkId, layerId])
        const image = await createImageBitmap(pngBlob)
        const canvas = document.createElement('canvas')
        canvas.width = image.width
        canvas.height = image.height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(image, 0, 0)
        image.close()
        samples.push([ctx.getImageData(420, 510, 1, 1).data[3], ctx.getImageData(390, 630, 1, 1).data[3]])
      }
      return samples
    }, [uidA, layered.artworkId, blueId, redId])
    assert.deepEqual(alpha, [[255, 0], [0, 255]])
    await page.reload()
    await ready()
    assert.deepEqual(await pixels(), expected)
  })
  await check('deletion_during_PNG_encoding_removes_metadata_and_content_permanently', async () => {
    const panel = await openLayers()
    await encodeMode('pause-once')
    await stroke([[280, 440], [480, 440]])
    await page.waitForFunction(() => typeof window.canvasTestEncoding.release === 'function')
    await panel.getByRole('button', { name: '레이어 삭제' }).click()
    assert.equal(await panel.getByRole('button', { name: '레이어 삭제' }).isDisabled(), true)
    const expected = await pixels()
    await page.evaluate(() => window.canvasTestEncoding.release())
    await saved()
    assert.equal(await rawContent(layered.artworkId, uidA, blueId), null)
    assert.deepEqual((await layerRows(layered.artworkId)).map(layer => layer.layerId), [redId])
    await page.reload()
    await ready()
    assert.deepEqual(await pixels(), expected)
    assert.deepEqual((await layerRows(layered.artworkId)).map(layer => layer.layerId), [redId])
    await page.screenshot({ path: join(outputDir, 'restored-layers.png'), animations: 'disabled' })
  })
  await check('failed_layer_settings_transaction_preserves_the_committed_order_and_PNG', async () => {
    const panel = await openLayers()
    const before = await layerRows(layered.artworkId)
    const original = await rawContent(layered.artworkId, uidA, redId)
    const metadata = await artwork(layered.artworkId)
    await page.evaluate(async () => {
      const { localDb } = await import('/src/db/localDb.js')
      window.failedSettingsCommit = () => { throw new DOMException('test quota', 'QuotaExceededError') }
      localDb.artworks.hook('updating', window.failedSettingsCommit)
    })
    await panel.getByRole('button', { name: '레이어 추가' }).click()
    await page.getByRole('alert').waitFor()
    assert.equal(await panel.locator('.layer-row').count(), 2)
    assert.deepEqual(await layerRows(layered.artworkId), before)
    assert.deepEqual(await rawContent(layered.artworkId, uidA, redId), original)
    assert.deepEqual(await artwork(layered.artworkId), metadata)
    await page.evaluate(async () => (await import('/src/db/localDb.js')).localDb.artworks.hook('updating').unsubscribe(window.failedSettingsCommit))
    await page.getByRole('button', { name: '다시 저장', exact: true }).click()
    await saved()
    assert.equal((await layerRows(layered.artworkId)).length, 2)
  })
  await check('mobile_touch_stroke_persists_a_transparent_layer', async () => {
    const touchArtwork = await create('터치 입력 검증', 320, 240)
    await page.setViewportSize({ width: 390, height: 844 })
    await open(touchArtwork.artworkId)
    const cdp = await context.newCDPSession(page)
    try {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true })
      const { x, y, width, height } = await page.locator('.drawcanvas').boundingBox()
      const at = offset => [{ x: x + width * offset, y: y + height * 0.4 }]
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0.25) })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(0.6) })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await saved()
      const raster = await rawContent(touchArtwork.artworkId)
      assert.deepEqual([raster.width, raster.height], [320, 240])
      assert.equal((await sample(0, 0))[3], 0)
      assert.ok((await sample(140, 96))[3] > 0)
      assert.deepEqual(raster.pixels, await pixels())
      await page.reload()
      await ready()
      assert.deepEqual(await pixels(), raster.pixels)
    } finally {
      await cdp.detach()
    }
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  const toolsArtwork = await create('그림 도구 병합 검증', 320, 240)
  await open(toolsArtwork.artworkId)
  const panel = await openLayers()
  const thumbAlpha = () => panel.locator('.layer-row').evaluateAll(rows => rows.map(row => {
    const canvas = row.querySelector('.layer-thumb')
    return canvas.getContext('2d').getImageData(0, 0, 80, 80).data.some((value, i) => i % 4 === 3 && value > 0)
  }))
  await check('layer_thumbnails_track_only_the_changed_original_and_restore_after_reload', async () => {
    assert.deepEqual(await thumbAlpha(), [false])
    await stroke([[60, 90], [130, 90]])
    await saved()
    assert.deepEqual(await thumbAlpha(), [true])
    await panel.getByRole('button', { name: '레이어 추가' }).click()
    await saved()
    assert.deepEqual(await thumbAlpha(), [false, true])
    await stroke([[150, 70], [170, 70]])
    await saved()
    assert.deepEqual(await thumbAlpha(), [true, true])
    await page.reload()
    await ready()
    await openLayers()
    assert.deepEqual(await thumbAlpha(), [true, true])
  })
  await page.locator('.layer-close').click()
  await check('brush_size_selection_move_and_undo_redo_commit_pixels_by_layer', async () => {
    const slider = page.getByRole('slider', { name: '브러시 크기' })
    await slider.focus()
    await page.keyboard.press('End')
    assert.equal(await slider.inputValue(), '100')
    await page.keyboard.press('Tab')
    await stroke([[210, 120]])
    await saved()
    assert.ok((await sample(230, 120))[3] > 0)
    await page.keyboard.press('Control+z')
    await saved()
    assert.equal((await sample(230, 120))[3], 0)
    await page.locator('label[for="select"]').click()
    await stroke([[142, 63], [179, 78]])
    await stroke([[155, 70], [193, 103]])
    await saved()
    assert.equal((await sample(155, 70))[3], 0)
    assert.ok((await sample(193, 103))[3] > 0)
    await page.keyboard.press('Control+z')
    await saved()
    assert.ok((await sample(155, 70))[3] > 0)
    await page.keyboard.press('Control+Shift+z')
    await saved()
    assert.ok((await sample(193, 103))[3] > 0)
    const moved = await pixels()
    await page.reload()
    await ready()
    assert.deepEqual(await pixels(), moved)
  })
  await check('dragged_picker_color_fills_the_selected_layer_and_survives_reload', async () => {
    await chooseColor(0)
    const picker = await page.getByRole('button', { name: '색 지정' }).boundingBox()
    const box = await page.locator('.drawcanvas').boundingBox()
    await page.mouse.move(picker.x + picker.width / 2, picker.y + picker.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.55, { steps: 10 })
    await page.mouse.up()
    await saved()
    const expected = await sample(224, 132)
    assert.ok(expected[0] > 200 && expected[1] < 60 && expected[3] === 255)
    await page.reload()
    await ready()
    assert.deepEqual(await sample(224, 132), expected)
  })
  const aiArtwork = await create('레이어 AI 병합 검증', 320, 240)
  await open(aiArtwork.artworkId)
  const aiPanel = await openLayers()
  await aiPanel.getByRole('button', { name: '레이어 추가' }).click()
  await saved()
  const encoderPattern = /\/vit_encoder[^/]*\.onnx(?:\?.*)?$/
  const busy = page.getByText('AI 레이어 분류 중…', { exact: true })
  await check('model_download_failure_preserves_drawn_pixels_and_allows_retries', async () => {
    await page.route(encoderPattern, route => route.abort(), { times: 1 })
    await page.getByRole('checkbox', { name: 'AI 레이어 분류' }).check()
    await stroke([[65, 90], [115, 90]])
    await page.getByText(/AI 모델을 불러오거나 실행하지 못했습니다/).waitFor()
    await saved()
    assert.equal((await sample(85, 90))[3], 255)
    assert.equal((await layerRows(aiArtwork.artworkId))[0].category, null)
  })
  await check('delayed_AI_cannot_change_an_old_layer_and_real_ONNX_classification_is_saved', async () => {
    let intercepted, release
    const requested = new Promise(resolve => { intercepted = resolve })
    const gate = new Promise(resolve => { release = resolve })
    await page.route(encoderPattern, async route => {
      intercepted()
      await gate
      await route.continue()
    }, { times: 1 })
    try {
      await stroke([[65, 104], [115, 104]])
      await busy.waitFor()
      await Promise.race([requested, page.getByText(/AI 모델을 불러오거나 실행하지 못했습니다/).waitFor().then(
        () => { throw new Error('ONNX did not request the encoder') })])
      await aiPanel.locator('.layer-select').nth(1).click()
      await aiPanel.locator('.layer-select').nth(0).click()
    } finally { release() }
    await busy.waitFor({ state: 'hidden', timeout: 60000 })
    assert.deepEqual((await layerRows(aiArtwork.artworkId)).map(layer => layer.category), [null, null])

    await stroke([[65, 122], [115, 122]])
    const tagged = aiPanel.locator('.layer-tag')
    await tagged.waitFor({ timeout: 60000 })
    const category = await tagged.textContent()
    assert.ok(['명암', '선화', '채색'].includes(category))
    await saved()
    const png = await rawContent(aiArtwork.artworkId)
    assert.deepEqual(png.pixels, await pixels())
    assert.deepEqual((await layerRows(aiArtwork.artworkId)).map(layer => layer.category), [category, null])
    await page.reload()
    await ready()
    await openLayers()
    assert.equal(await tagged.textContent(), category)
    assert.deepEqual(await pixels(), png.pixels)
  })
  await check('no_uncaught_errors_or_production_artwork_requests', async () => {
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(forbiddenRequests, [])
  })
} catch (error) {
  results.push({ name: 'test_run', status: 'failed', error: error.message })
  console.error(error.stack)
  await page?.screenshot({ path: join(outputDir, 'failure.png'), animations: 'disabled' }).catch(() => {})
  process.exitCode = 1
} finally {
  // 이 실행에서 생성한 Emulator UID만 정리한다. 기존 브라우저/계정/DB 전체 삭제는 하지 않는다.
  const cleanup = []
  for (const userId of users) {
    try {
      const p = await fetch(`http://127.0.0.1:8080/v1/projects/ai-drawing-a9177/databases/(default)/documents/users/${encodeURIComponent(userId)}`, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } })
      assert.ok(p.ok || p.status === 404)
      const a = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/ai-drawing-a9177/accounts:delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify({ localId: userId }),
      })
      assert.ok(a.ok)
      cleanup.push({ status: 'removed' })
    } catch (error) { cleanup.push({ status: 'failed', error: error.message }); process.exitCode = 1 }
  }
  await browser?.close()
  await server?.close()
  await writeFile(join(outputDir, 'report.json'), JSON.stringify({ results, cleanup, pageErrors, forbiddenRequests, networkErrors, consoleErrors }, null, 2))
  if (process.exitCode) console.log(JSON.stringify({ networkErrors, consoleErrors }))
  console.log(JSON.stringify({ passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length, cleanup, outputDir }))
}
