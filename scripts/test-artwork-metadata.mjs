// 실행: node scripts/test-artwork-metadata.mjs (Playwright + Edge, 실행 중인 로컬 Emulators 필요)
// 별도 브라우저 컨텍스트만 사용한다. 기존 브라우저 DB를 초기화하지 않는다.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright')
const runId = crypto.randomUUID()
const outputDir = join(tmpdir(), `intelligentcanvas-metadata-${runId}`)
await mkdir(outputDir, { recursive: true })
const base = 'http://127.0.0.1:5187'
const password = `Canvas-${runId}!`
const emails = { a: `metadata-${runId}-a@example.test`, b: `metadata-${runId}-b@example.test` }
const users = new Set()
const results = []
const pageErrors = []
const forbiddenRequests = []
let server, browser, context, page
let uidA, uidB, a1, a2, b1

async function check(name, action) {
  await action()
  results.push({ name, status: 'passed' })
  console.log(JSON.stringify({ name, status: 'passed' }))
}
async function currentUid() {
  return page.evaluate(async () => {
    const { auth } = await import('/src/config/firebase.js')
    await auth.authStateReady()
    return auth.currentUser?.uid ?? null
  })
}
async function records(uid) {
  return page.evaluate(async uid => (await import('/src/repositories/artworkRepository.js')).listArtworks(uid), uid)
}
async function rawRecord(uid, id) {
  return page.evaluate(async ([uid, id]) => (await import('/src/db/localDb.js')).localDb.artworks.get([uid, id]), [uid, id])
}
async function titles(expected, target = page) {
  await target.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('.card-title')].map(el => el.textContent)) === JSON.stringify(expected), expected)
}
async function signup(email) {
  await page.goto(`${base}/signup`)
  await page.locator('#signup-username').fill('그림친구')
  await page.locator('#signup-email').fill(email)
  await page.locator('#signup-password').fill(password)
  await page.locator('#signup-confirm-password').fill(password)
  await page.waitForFunction(() => !document.querySelector('button[type=submit]').disabled)
  await page.locator('button[type=submit]').click()
  await page.waitForURL(`${base}/`, { timeout: 25000 })
  const uid = await currentUid()
  assert.ok(uid)
  users.add(uid)
  return uid
}
async function logout() {
  await page.evaluate(async () => (await import('/src/services/authService.js')).logoutUser())
  assert.equal(await currentUid(), null)
}
async function fillNew(title, width = '800', height = '800') {
  await page.getByRole('button', { name: '+ 새 작품', exact: true }).click()
  await page.locator('#new-artwork-title').fill(title)
  await page.getByLabel('가로 픽셀').fill(width)
  await page.getByLabel('세로 픽셀').fill(height)
}
async function create(title, width, height) {
  await fillNew(title, width, height)
  await page.getByRole('button', { name: '확인', exact: true }).click()
  await page.getByRole('dialog', { name: '새 작품', exact: true }).waitFor({ state: 'hidden' })
  return (await records(await currentUid())).find(record => record.title === title)
}
async function openActions(title) {
  await page.getByRole('button', { name: `${title} 관리`, exact: true }).click()
  await page.getByRole('dialog', { name: '작품 관리', exact: true }).waitFor()
}

try {
  const hub = await (await fetch('http://127.0.0.1:4400/emulators')).json()
  assert.equal(hub.auth.port, 9099)
  assert.equal(hub.firestore.port, 8081)
  server = await createServer({ server: { host: '127.0.0.1', port: 5187, strictPort: true }, logLevel: 'error' })
  await server.listen()
  browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'msedge', headless: true })
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.grantPermissions(['local-network-access'], { origin: base })
  await context.route('**/*', route => {
    const request = route.request()
    const url = new URL(request.url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
      forbiddenRequests.push(url.origin)
      return route.abort()
    }
    // 이번 단계에서 작품/Storage/Functions 요청이 생기면 테스트 실패로 기록한다.
    // 5-B는 등록 여부를 Listen으로 읽는다. 작품 쓰기와 세션 경로 접근은 감시한다.
    const payload = request.postData() || url.pathname
    if (url.port === '8081' && (/editSession|revisions/.test(payload)
      || (/artworks/.test(payload) && !/\/Listen\/channel$/.test(url.pathname)))) forbiddenRequests.push('server-artwork-request')
    if (!['5187', '9099', '8081'].includes(url.port)) forbiddenRequests.push(url.origin)
    return route.continue()
  })
  context.on('page', opened => opened.on('pageerror', error => pageErrors.push(error.message)))
  page = await context.newPage()
  page.setDefaultTimeout(12000)

  await check('signed_out_UI_and_all_repository_operations_denied', async () => {
    await page.goto(base)
    await page.waitForURL(`${base}/login`)
    await page.locator('#login-email').waitFor()
    assert.equal(await page.locator('.new-button').count(), 0)
    assert.equal(await page.locator('.artwork-card').count(), 0)
    const denied = await page.evaluate(async () => {
      const r = await import('/src/repositories/artworkRepository.js')
      return Promise.all([
        () => r.listArtworks('not-signed-in'), () => r.getArtwork('not-signed-in', 'id'),
        () => r.createArtwork('not-signed-in', {}), () => r.renameArtwork('not-signed-in', 'id', 'x'),
        () => r.deleteArtwork('not-signed-in', 'id'),
      ].map(async fn => { try { await fn(); return 'ALLOWED' } catch (error) { return error.code } }))
    })
    assert.deepEqual(denied, Array(5).fill('artwork/auth-required'))
  })
  await check('signed_out_direct_drawing_and_server_snapshot_never_mount_canvas', async () => {
    const id = crypto.randomUUID()
    for (const suffix of ['', '?view=server']) {
      await page.goto(`${base}/drawing/${id}${suffix}`)
      const login = page.getByRole('link', { name: '로그인', exact: true })
      await login.waitFor()
      assert.equal(await page.locator('canvas').count(), 0)
      await login.click()
      await page.waitForURL(`${base}/login`)
    }
  })
  await check('login_signup_back_and_legacy_signup_routes', async () => {
    const goBack = () => page.getByRole('button', { name: '로그인 화면으로 돌아가기' }).click()
    await page.getByRole('button', { name: '회원가입', exact: true }).click()
    await page.waitForURL(`${base}/signup`)
    await goBack()
    await page.waitForURL(`${base}/login`)
    await page.goForward()
    await page.waitForURL(`${base}/signup`)

    const direct = await page.context().newPage()
    try {
      await direct.goto(`${base}/singup`)
      await direct.waitForURL(`${base}/signup`)
      await direct.getByRole('button', { name: '로그인 화면으로 돌아가기' }).click()
      await direct.waitForURL(`${base}/login`)
    } finally {
      await direct.close()
    }
  })
  await check('existing_signup_and_Firestore_profile_for_A', async () => {
    uidA = await signup(emails.a)
    const profile = await page.evaluate(async uid => (await import('/src/services/userService.js')).getUserProfile(uid), uidA)
    assert.equal(profile.uid, uidA)
    assert.equal(profile.nickname, '그림친구')
    assert.deepEqual(Object.keys(profile).sort(), ['createdAt', 'nickname', 'schemaVersion', 'uid', 'updatedAt'])
    await page.getByText('작품이 없습니다. 새 작품을 만들어 보세요.', { exact: true }).waitFor()
  })
  await check('invalid_dimensions_rejected_by_UI_and_repository', async () => {
    await fillNew('크기 검사', '0', '800')
    await page.getByRole('button', { name: '확인', exact: true }).click()
    assert.equal(await page.getByLabel('가로 픽셀').evaluate(input => input.validity.rangeUnderflow), true)
    assert.equal((await records(uidA)).length, 0)
    await page.getByRole('dialog', { name: '새 작품', exact: true }).getByRole('button', { name: '취소', exact: true }).click()
    const denied = await page.evaluate(async uid => {
      const r = await import('/src/repositories/artworkRepository.js')
      const bad = [0, -1, 1.5, '', 'bad', 8193, Infinity, Number.MAX_SAFE_INTEGER + 1]
      return Promise.all(bad.map(async width => {
        try { await r.createArtwork(uid, { title: 'invalid', width }); return 'ALLOWED' } catch (error) { return error.code }
      }))
    }, uidA)
    assert.deepEqual(denied, Array(8).fill('artwork/invalid-size'))
  })
  await check('write_failure_retains_form_and_creates_no_record', async () => {
    await page.evaluate(async () => {
      const { localDb } = await import('/src/db/localDb.js')
      window.failMetadataWrite = () => { throw new DOMException('test quota', 'QuotaExceededError') }
      localDb.artworks.hook('creating', window.failMetadataWrite)
    })
    await fillNew('A1 풍경', '1024', '768')
    await page.getByRole('button', { name: '확인', exact: true }).click()
    await page.getByRole('alert').waitFor()
    assert.match(await page.getByRole('alert').innerText(), /저장 공간이 부족/)
    assert.equal(await page.locator('#new-artwork-title').inputValue(), 'A1 풍경')
    assert.equal((await records(uidA)).length, 0)
    await page.evaluate(async () => {
      const { localDb } = await import('/src/db/localDb.js')
      localDb.artworks.hook('creating').unsubscribe(window.failMetadataWrite)
      delete window.failMetadataWrite
    })
  })
  await check('create_A1_with_double_submit_protection', async () => {
    await page.evaluate(() => {
      const form = document.querySelector('form[aria-labelledby=new-artwork-heading]')
      form.requestSubmit(); form.requestSubmit()
    })
    await titles(['A1 풍경'])
    const rows = await records(uidA)
    assert.equal(rows.length, 1)
    a1 = rows[0]
    assert.match(a1.artworkId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.equal(a1.width, 1024)
    assert.equal(a1.height, 768)
    assert.equal(a1.backgroundColor, '#ffffff')
    assert.equal(a1.uid, uidA)
    assert.equal(a1.schemaVersion, 1)
    assert.equal(a1.state, 'active')
    assert.equal(a1.deletedAt, null)
    assert.equal(typeof a1.createdAt, 'number')
    assert.equal(a1.createdAt, a1.updatedAt)
  })
  await check('create_A2_and_list_two_owned_artworks', async () => {
    a2 = await create('A2 연습')
    assert.notEqual(a1.artworkId, a2.artworkId)
    assert.equal(a2.width, 800)
    assert.equal(a2.height, 800)
    await titles(['A2 연습', 'A1 풍경'])
  })
  await check('title_substring_normalized_search_and_empty_result', async () => {
    await page.getByLabel('작품 검색', { exact: true }).fill('  ａ１ ')
    await titles(['A1 풍경'])
    await page.getByLabel('작품 검색', { exact: true }).fill('풍경')
    await titles(['A1 풍경'])
    await page.getByLabel('작품 검색', { exact: true }).fill('없는 작품')
    await page.getByText('검색 결과가 없습니다', { exact: true }).waitFor()
    await page.getByLabel('작품 검색', { exact: true }).fill('')
    await titles(['A2 연습', 'A1 풍경'])
  })
  await check('rename_updates_title_search_and_updatedAt_only', async () => {
    await openActions('A1 풍경')
    await page.locator('#rename-artwork-title').fill('  ')
    await page.getByRole('button', { name: '제목 변경', exact: true }).click()
    await page.getByRole('alert').waitFor()
    assert.match(await page.getByRole('alert').innerText(), /제목은/)
    await page.locator('#rename-artwork-title').fill('A1 수정')
    await page.getByRole('button', { name: '제목 변경', exact: true }).click()
    await titles(['A1 수정', 'A2 연습'])
    const updated = await rawRecord(uidA, a1.artworkId)
    assert.equal(updated.createdAt, a1.createdAt)
    assert.ok(updated.updatedAt > a1.updatedAt)
    assert.equal(updated.uid, a1.uid)
    assert.equal(updated.width, 1024)
    assert.equal(updated.titleNormalized, 'a1 수정')
  })
  await check('created_updated_and_name_sort_apply_to_stored_records', async () => {
    await page.getByLabel('작품 정렬').selectOption('createdAt')
    await titles(['A2 연습', 'A1 수정'])
    await page.getByLabel('작품 정렬').selectOption('updatedAt')
    await titles(['A1 수정', 'A2 연습'])
    await page.getByLabel('작품 정렬').selectOption('title')
    await titles(['A1 수정', 'A2 연습'])
  })
  await check('delete_cancel_keeps_identical_record', async () => {
    const before = await rawRecord(uidA, a2.artworkId)
    await openActions('A2 연습')
    page.once('dialog', dialog => dialog.dismiss())
    await page.getByRole('button', { name: '삭제', exact: true }).click()
    assert.deepEqual(await rawRecord(uidA, a2.artworkId), before)
    await page.getByRole('dialog', { name: '작품 관리', exact: true }).getByRole('button', { name: '취소', exact: true }).click()
  })
  await check('delete_marks_tombstone_and_denies_reopen', async () => {
    const extra = await create('삭제 테스트')
    await openActions(extra.title)
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: '삭제', exact: true }).click()
    await titles(['A1 수정', 'A2 연습'])
    const deleted = await rawRecord(uidA, extra.artworkId)
    assert.equal(deleted.state, 'deleted')
    assert.equal(deleted.deletedAt, deleted.updatedAt)
    assert.equal(deleted.createdAt, extra.createdAt)
    await page.goto(`${base}/drawing/${extra.artworkId}`)
    await page.getByRole('alert').waitFor()
    assert.equal(await page.locator('canvas').count(), 0)
    await page.goto(base)
    await titles(['A1 수정', 'A2 연습'])
  })
  await check('refresh_and_DB_reopen_preserve_metadata', async () => {
    await page.reload()
    await titles(['A1 수정', 'A2 연습'])
    const info = await page.evaluate(async () => {
      const { localDb } = await import('/src/db/localDb.js')
      localDb.close()
      await localDb.open()
      return { name: localDb.name, version: localDb.verno, tables: localDb.tables.map(t => t.name), count: await localDb.artworks.count() }
    })
    assert.deepEqual(info, { name: 'IntelligentCanvasLocal', version: 5, tables: ['artworks', 'canvasContents', 'layers', 'layerContents', 'artworkSync', 'syncQueue', 'recoveryDrafts'], count: 3 })
    assert.equal(await currentUid(), uidA)
  })
  await check('query_error_and_retry', async () => {
    await page.evaluate(async () => (await import('/src/db/localDb.js')).localDb.close())
    await page.getByLabel('작품 검색', { exact: true }).fill('A1')
    await page.getByRole('alert').waitFor()
    assert.match(await page.getByRole('alert').innerText(), /로컬 DB를 열지 못했습니다/)
    await page.evaluate(async () => (await import('/src/db/localDb.js')).localDb.open())
    await page.getByRole('button', { name: '다시 시도', exact: true }).click()
    await titles(['A1 수정'])
    await page.getByLabel('작품 검색', { exact: true }).fill('')
    await titles(['A1 수정', 'A2 연습'])
  })
  await check('card_opens_correct_ID_metadata_and_persistent_canvas', async () => {
    await page.getByRole('button', { name: 'A1 수정 열기', exact: true }).click()
    await page.waitForURL(`${base}/drawing/${a1.artworkId}`)
    await page.locator('canvas').waitFor()
    await page.waitForFunction(() => document.querySelector('.drawcanvas')?.dataset.ready === 'true')
    const info = page.getByLabel('현재 작품 정보', { exact: true })
    assert.equal(await info.getAttribute('data-artwork-id'), a1.artworkId)
    assert.match(await info.innerText(), /1024 × 768px/)
    assert.equal(await page.locator('canvas').getAttribute('width'), '1024')
    assert.equal(await page.locator('canvas').getAttribute('height'), '768')
    const box = await page.locator('canvas').boundingBox()
    await page.mouse.move(box.x + box.width / 2 - 20, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    assert.equal(await page.locator('canvas').evaluate(c => c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((n, i) => i % 4 === 3 && n > 0)), true)
    await page.getByRole('status').filter({ hasText: '이 브라우저에 저장됨' }).waitFor()
    await page.locator('.layer-toggle').click()
    assert.equal(await page.locator('.layer-row').count(), 1)
    await page.reload()
    await page.getByLabel('현재 작품 정보', { exact: true }).waitFor()
    await page.waitForFunction(() => document.querySelector('.drawcanvas')?.dataset.ready === 'true')
    assert.equal(await page.locator('canvas').evaluate(c => c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((n, i) => i % 4 === 3 && n > 0)), true)
    await page.screenshot({ path: join(outputDir, 'drawing-metadata.png'), animations: 'disabled' })
  })
  await check('missing_ID_and_legacy_drawing_route', async () => {
    await page.goto(`${base}/drawing/${crypto.randomUUID()}`)
    await page.getByRole('alert').waitFor()
    assert.equal(await page.locator('canvas').count(), 0)
    await page.goto(`${base}/drawing`)
    await page.waitForURL(`${base}/`)
    await titles(['A1 수정', 'A2 연습'])
  })
  await check('logout_clears_list_without_deleting_local_data', async () => {
    await openActions('A1 수정')
    await logout()
    await page.waitForURL(`${base}/login`)
    await page.locator('#login-email').waitFor()
    assert.equal(await page.locator('.artwork-card').count(), 0)
    assert.equal(await page.getByRole('dialog').count(), 0)
    assert.equal((await rawRecord(uidA, a1.artworkId)).title, 'A1 수정')
  })
  await check('B_same_nickname_signup_sees_only_B1', async () => {
    uidB = await signup(emails.b)
    assert.notEqual(uidA, uidB)
    await page.getByText('작품이 없습니다. 새 작품을 만들어 보세요.', { exact: true }).waitFor()
    b1 = await create('B1 그림')
    await titles(['B1 그림'])
    assert.equal((await records(uidB)).length, 1)
  })
  await check('B_cannot_open_modify_delete_or_spoof_A_UID', async () => {
    const before = await rawRecord(uidA, a1.artworkId)
    await page.goto(`${base}/drawing/${a1.artworkId}`)
    await page.getByRole('alert').waitFor()
    assert.equal(await page.locator('canvas').count(), 0)
    const denied = await page.evaluate(async ({ uidA, uidB, id }) => {
      const r = await import('/src/repositories/artworkRepository.js')
      return Promise.all([
        () => r.getArtwork(uidB, id), () => r.renameArtwork(uidB, id, '침범'), () => r.deleteArtwork(uidB, id),
        () => r.listArtworks(uidA), () => r.getArtwork(uidA, id), () => r.createArtwork(uidA),
        () => r.renameArtwork(uidA, id, '침범'), () => r.deleteArtwork(uidA, id),
      ].map(async fn => { try { await fn(); return 'ALLOWED' } catch (error) { return error.code } }))
    }, { uidA, uidB, id: a1.artworkId })
    assert.deepEqual(denied, [...Array(3).fill('artwork/not-found'), ...Array(5).fill('artwork/auth-changed')])
    assert.deepEqual(await rawRecord(uidA, a1.artworkId), before)
  })
  await check('logout_hides_open_drawing_and_login_errors_still_work', async () => {
    await page.goto(`${base}/drawing/${b1.artworkId}`)
    await page.locator('canvas').waitFor()
    await logout()
    await page.getByRole('link', { name: '로그인', exact: true }).waitFor()
    assert.equal(await page.locator('canvas').count(), 0)
    await page.getByRole('link', { name: '로그인', exact: true }).click()
    await page.locator('#login-email').fill(emails.a)
    await page.locator('#login-password').fill('wrong-password')
    await page.locator('button[type=submit]').click()
    await page.locator('.auth-error').waitFor()
    assert.match(await page.locator('.auth-error').innerText(), /올바르지 않습니다/)
    assert.equal(await currentUid(), null)
  })
  await check('A_relogin_restores_A1_A2_and_hides_B1', async () => {
    await page.locator('#login-password').fill(password)
    await page.locator('button[type=submit]').click()
    await page.waitForURL(`${base}/`)
    assert.equal(await currentUid(), uidA)
    await titles(['A1 수정', 'A2 연습'])
    assert.equal((await records(uidA)).length, 2)
    await page.screenshot({ path: join(outputDir, 'artwork-list.png'), animations: 'disabled' })
  })
  await check('live_updates_from_another_tab_and_opened_deleted_artwork', async () => {
    const other = await context.newPage()
    await other.goto(`${base}/drawing/${a2.artworkId}`)
    await other.locator('canvas').waitFor()
    await page.evaluate(async ({ uid, id }) => (await import('/src/repositories/artworkRepository.js')).renameArtwork(uid, id, 'A2 다른 탭'), { uid: uidA, id: a2.artworkId })
    await other.waitForFunction(() => document.querySelector('aside[aria-label="현재 작품 정보"]')?.textContent.includes('A2 다른 탭'))
    await titles(['A2 다른 탭', 'A1 수정'])
    const temporary = await create('다른 탭 삭제 검사')
    await other.goto(`${base}/drawing/${temporary.artworkId}`)
    await other.locator('canvas').waitFor()
    await page.evaluate(async ({ uid, id }) => (await import('/src/repositories/artworkRepository.js')).deleteArtwork(uid, id), { uid: uidA, id: temporary.artworkId })
    await other.getByRole('alert').waitFor()
    assert.equal(await other.locator('canvas').count(), 0)
    await other.close()
    await page.evaluate(async ({ uid, id }) => (await import('/src/repositories/artworkRepository.js')).renameArtwork(uid, id, 'A2 연습'), { uid: uidA, id: a2.artworkId })
    await titles(['A2 연습', 'A1 수정'])
  })
  await check('default_title_dimensions_and_expected_tables', async () => {
    await fillNew('')
    await page.getByRole('button', { name: '확인', exact: true }).click()
    await titles(['제목 없음', 'A2 연습', 'A1 수정'])
    const blank = (await records(uidA))[0]
    assert.equal(blank.title, '제목 없음')
    assert.equal(blank.width, 800)
    assert.equal(blank.height, 800)
    await page.evaluate(async ({ uid, id }) => (await import('/src/repositories/artworkRepository.js')).deleteArtwork(uid, id), { uid: uidA, id: blank.artworkId })
    await titles(['A2 연습', 'A1 수정'])
    const tables = await page.evaluate(async () => (await import('/src/db/localDb.js')).localDb.tables.map(t => t.name))
    assert.deepEqual(tables, ['artworks', 'canvasContents', 'layers', 'layerContents', 'artworkSync', 'syncQueue', 'recoveryDrafts'])
  })
  await check('mobile_existing_layout_and_new_menu', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await fillNew('모바일 확인')
    assert.equal(await page.getByRole('button', { name: '확인', exact: true }).isVisible(), true)
    const dialog = await page.getByRole('dialog', { name: '새 작품', exact: true }).boundingBox()
    assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= 390)
    await page.screenshot({ path: join(outputDir, 'mobile-new-artwork.png'), animations: 'disabled' })
    assert.equal(await page.locator('#new-artwork-heading').evaluate(element => {
      const rect = element.getBoundingClientRect()
      return !!document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('form[aria-labelledby="new-artwork-heading"]')
    }), true)
    await page.getByRole('dialog', { name: '새 작품', exact: true }).getByRole('button', { name: '취소', exact: true }).click()
    await page.setViewportSize({ width: 1280, height: 900 })
  })
  await check('no_uncaught_errors_no_production_or_artwork_server_writes', async () => {
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(forbiddenRequests, [])
  })
} catch (error) {
  results.push({ name: 'test_run', status: 'failed', error: error.message })
  console.error(error.stack)
  await page?.screenshot({ path: join(outputDir, 'failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  // 이 테스트가 만든 UID만 Emulator 관리 API로 정리한다. 기존 계정/DB 전체 삭제 없음.
  const cleanup = []
  for (const uid of users) {
    try {
      const p = await fetch(`http://127.0.0.1:8081/v1/projects/ai-drawing-a9177/databases/(default)/documents/users/${encodeURIComponent(uid)}`, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } })
      assert.ok(p.ok || p.status === 404)
      const a = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/ai-drawing-a9177/accounts:delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify({ localId: uid }),
      })
      assert.ok(a.ok)
      cleanup.push({ status: 'removed' })
    } catch (error) { cleanup.push({ status: 'failed', error: error.message }); process.exitCode = 1 }
  }
  await browser?.close()
  await server?.close()
  await writeFile(join(outputDir, 'report.json'), JSON.stringify({ results, cleanup, pageErrors, forbiddenRequests }, null, 2))
  console.log(JSON.stringify({ passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length, cleanup, outputDir }))
}
