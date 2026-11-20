import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright')
const projectId = 'ai-drawing-a9177'
const bucket = 'intelligentcanvas-stage5a-local.invalid'
const base = 'http://127.0.0.1:5190'
const runId = crypto.randomUUID()
const outputDir = join(tmpdir(), `intelligentcanvas-server-${runId}`)
const password = `Canvas-${runId}!`
const users = new Set()
const writtenDocs = []
const writtenObjects = new Set()
const results = []
const cleanupErrors = []
const externalRequests = []
const pageErrors = []
const ports = { auth: 9099, firestore: 8080, storage: 9199, functions: 5001 }
let server, browser, page

// Vite가 테스트에서만 이 모듈을 제공한다. 서비스 운영 코드나 빌드에는 포함하지 않는다.
const fixture = '/__stage5a-tests.js'
const fixtureSource = String.raw`
  import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from 'firebase/auth'
  import { collection, doc, getDocFromServer, getDocsFromServer, query, where, setDoc, updateDoc, deleteDoc } from 'firebase/firestore'
  import { deleteObject, getBytes, listAll, ref, uploadBytes } from 'firebase/storage'
  import { auth, db } from '/src/config/firebase.js'
  import { checkServerEnvironment, storage } from '/src/config/firebaseServerEmulators.js'
  export { runServerEmulatorSmokeTest as smoke } from '/src/dev/serverEmulatorSmokeTest.js'
  export { registerUser } from '/src/services/authService.js'
  export { ensureUserProfile, updateNickname } from '/src/services/userService.js'
  export async function authSignup({ email, password }) {
    return (await createUserWithEmailAndPassword(auth, email, password)).user.uid
  }
  export async function login(email, password) {
    return (await signInWithEmailAndPassword(auth, email, password)).user.uid
  }
  export const logout = () => signOut(auth)
  export const ready = () => auth.authStateReady()
  export const check = async (data = {}) => (await checkServerEnvironment(data)).data
  export const get = async path => (await getDocFromServer(doc(db, path))).data() ?? null
  export const list = async (path, ownerUid) => {
    const source = collection(db, path)
    const request = ownerUid ? query(source, where('ownerUid', '==', ownerUid)) : source
    return (await getDocsFromServer(request)).docs.map(snapshot => snapshot.id)
  }
  export const set = async (path, data) => { await setDoc(doc(db, path), data) }
  export const update = async (path, data) => { await updateDoc(doc(db, path), data) }
  export const remove = async path => { await deleteDoc(doc(db, path)) }
  export const upload = async (path, text, contentType = 'text/plain') => {
    await uploadBytes(ref(storage, path), new Blob([text], { type: contentType }))
  }
  export const download = async path => new TextDecoder().decode(await getBytes(ref(storage, path), 256))
  export const listFiles = async path => (await listAll(ref(storage, path))).items.length
  export const deleteFile = async path => { await deleteObject(ref(storage, path)) }
`

async function invoke(name, ...args) {
  const result = await page.evaluate(async ({ name, args, fixture }) => {
    try {
      const module = await import(fixture)
      const value = await module[name](...args)
      if (name === 'registerUser') return { value: value.user.uid }
      return { value }
    } catch (error) { return { code: error.code || 'unexpected', message: error.message } }
  }, { name, args, fixture })
  if ('code' in result) throw Object.assign(new Error(result.message), { code: result.code })
  return result.value
}

async function check(name, run) {
  await run()
  results.push({ name, status: 'passed' })
  console.log(`PASS ${name}`)
}

async function hub(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/emulators`, { signal: AbortSignal.timeout(3000) })
    return response.ok ? await response.json() : {}
  } catch { return {} }
}

async function readLocalStatus() {
  const primary = await hub(4400)
  const secondary = ports.storage === primary.storage?.port && ports.functions === primary.functions?.port
    ? {} : await hub(4401)
  for (const [service, port] of Object.entries(ports)) {
    const serverInfo = primary[service] ?? secondary[service]
    assert.equal(serverInfo?.port, port, `${service} must be running on ${port}`)
    assert.ok(['127.0.0.1', 'localhost'].includes(serverInfo.host), `${service} must use loopback`)
  }
  for (const current of [primary, secondary].filter(value => value.ui)) {
    const response = await fetch(`http://127.0.0.1:${current.ui.port}/`, { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /Emulator Suite/i)
  }
  assert.ok(primary.ui || secondary.ui, 'Emulator UI must be running')
}

const documents = `http://127.0.0.1:${ports.firestore}/v1/projects/${projectId}/databases/(default)/documents`
const admin = { Authorization: 'Bearer owner' }
async function seed(path, fields) {
  // Node REST는 이 실행의 새 계정 아래에만 서버 생성 문서를 준비한다.
  assert.ok(users.has(path.split('/')[1]))
  writtenDocs.push(path)
  const response = await fetch(`${documents}/${path}`, {
    method: 'PATCH', headers: { ...admin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([key, value]) =>
      [key, typeof value === 'number' ? { integerValue: String(value) } : { stringValue: value }])) }),
  })
  assert.equal(response.status, 200, `Fixture write failed: HTTP ${response.status}`)
}

const firestoreDenied = (name, ...args) => assert.rejects(invoke(name, ...args), { code: 'permission-denied' })
const storageDenied = (name, ...args) => assert.rejects(invoke(name, ...args), { code: 'storage/unauthorized' })
const aLogin = { email: `server-${runId}-a@example.test`, password }
const bLogin = { email: `server-${runId}-b@example.test`, password }

try {
  await mkdir(outputDir, { recursive: true })
  await check('four_emulators_and_ui_respond_on_loopback', readLocalStatus)
  server = await createServer({
    server: { host: '127.0.0.1', port: 5190, strictPort: true, ws: false },
    plugins: [{
      name: 'stage5a-test-only',
      resolveId: id => id === fixture ? fixture : null,
      load: id => id === fixture ? fixtureSource : null,
    }],
    logLevel: 'error',
  })
  await server.listen()
  browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'msedge', headless: true })
  const context = await browser.newContext()
  await context.grantPermissions(['local-network-access'], { origin: base })
  const allowed = new Set([new URL(base).port, ...Object.values(ports).map(String)])
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1' && allowed.has(url.port)) return route.continue()
    externalRequests.push(url.origin)
    return route.abort()
  })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.goto(base)
  await invoke('ready')

  await check('callable_rejects_signed_out_user', async () => {
    await assert.rejects(invoke('check'), { code: 'functions/unauthenticated' })
  })

  const a = await invoke('registerUser', { ...aLogin, username: '5-A 테스트' })
  assert.ok(a)
  users.add(a)
  await check('web_sdk_calls_functions_and_storage_smoke_round_trip', async () => {
    assert.deepEqual(await invoke('check'), { ok: true, uid: a, profileExists: true })
    assert.deepEqual(await invoke('smoke'), {
      functions: 'ok', firestoreProfileExists: true, storage: 'ok', testObjectRemoved: true,
    })
  })
  await invoke('logout')
  const b = await invoke('authSignup', bLogin)
  assert.ok(b && a !== b)
  users.add(b)
  await check('callable_uses_token_uid_and_rejects_client_uid', async () => {
    assert.deepEqual(await invoke('check'), { ok: true, uid: b, profileExists: false })
    await assert.rejects(invoke('check', { uid: a }), { code: 'functions/invalid-argument' })
    await assert.rejects(invoke('check', []), { code: 'functions/invalid-argument' })
  })

  const artwork = `users/${a}/artworks/${runId}`
  const layer = `${artwork}/layers/fixture`
  const session = `${artwork}/editSession/current`
  const revision = `${artwork}/revisions/fixture`
  const receipt = `${artwork}/saveReceipts/fixture`
  const mismatched = `users/${a}/artworks/${crypto.randomUUID()}`
  await seed(artwork, { ownerUid: a, artworkId: runId, serverVersion: 1, schemaVersion: 1 })
  await seed(layer, { name: 'fixture', sortOrder: 0 })
  await seed(session, { sessionId: 'fixture', generation: 1 })
  await seed(revision, { serverVersion: 1 })
  await seed(receipt, { requestId: runId })
  await seed(mismatched, { ownerUid: b, serverVersion: 1 })
  const objectPath = `_emulatorChecks/${a}/${runId}.txt`
  const pending = `users/${a}/artworks/${runId}/staging/${runId}/fixture/raster.png`
  const committed = `users/${a}/artworks/${runId}/layers/fixture/${runId}/raster.png`
  for (const path of [objectPath, pending, committed]) writtenObjects.add(path)

  await check('another_uid_cannot_read_or_write_the_artwork_and_profile', async () => {
    await firestoreDenied('get', `users/${a}`)
    await firestoreDenied('update', `users/${a}`, { nickname: 'tampered' })
    await firestoreDenied('get', artwork)
    await firestoreDenied('get', layer)
    await firestoreDenied('list', `users/${a}/artworks`, a)
    await firestoreDenied('update', artwork, { serverVersion: 9 })
    await storageDenied('upload', objectPath, 'wrong user')
  })

  await check('profile_nicknames_can_match_and_ownership_fields_are_immutable', async () => {
    const otherProfile = await invoke('ensureUserProfile', b, '5-A 테스트')
    await invoke('logout')
    assert.equal(await invoke('login', aLogin.email, password), a)
    const oldProfile = await invoke('get', `users/${a}`)
    await invoke('updateNickname', a, '다른 이름')
    const current = await invoke('updateNickname', a, otherProfile.nickname)
    assert.equal(current.nickname, otherProfile.nickname)
    assert.equal(current.uid, a)
    assert.deepEqual(current.createdAt, oldProfile.createdAt)
    for (const change of [{ uid: b }, { createdAt: 'tampered' }, { schemaVersion: 9 }, { password: 'forbidden' }]) {
      await firestoreDenied('update', `users/${a}`, change)
    }
  })

  await invoke('logout')
  assert.equal(await invoke('login', aLogin.email, password), a)
  await check('owner_reads_artwork_and_layer_with_narrow_queries', async () => {
    assert.equal((await invoke('get', `users/${a}`)).uid, a)
    assert.equal((await invoke('get', artwork)).serverVersion, 1)
    assert.equal((await invoke('get', layer)).name, 'fixture')
    assert.deepEqual(await invoke('list', `users/${a}/artworks`, a), [runId])
    assert.deepEqual(await invoke('list', `${artwork}/layers`), ['fixture'])
    await firestoreDenied('list', `users/${a}/artworks`)
    await firestoreDenied('get', mismatched)
  })
  await check('owner_cannot_write_server_documents_or_read_internal_state', async () => {
    await firestoreDenied('set', `users/${a}/artworks/${crypto.randomUUID()}`, { ownerUid: a })
    await firestoreDenied('update', artwork, { serverVersion: 9 })
    await firestoreDenied('update', layer, { name: 'tampered' })
    await firestoreDenied('remove', artwork)
    for (const protectedDoc of [session, revision, receipt]) {
      await firestoreDenied('get', protectedDoc)
      await firestoreDenied('set', protectedDoc, { generation: 9 })
    }
    assert.equal((await invoke('get', artwork)).serverVersion, 1)
  })
  await check('storage_rejects_invalid_size_mime_filename_and_artwork_paths', async () => {
    await storageDenied('upload', objectPath, 'x'.repeat(257))
    await storageDenied('upload', objectPath, 'bad type', 'image/png')
    await storageDenied('upload', `_emulatorChecks/${a}/invalid.txt`, 'bad path')
    await storageDenied('upload', pending, 'test', 'image/png')
    await storageDenied('upload', committed, 'test', 'image/png')
    await storageDenied('download', committed)
  })
  await check('storage_owner_reads_test_file_but_cannot_overwrite_or_list', async () => {
    await invoke('upload', objectPath, '5-A test payload')
    assert.equal(await invoke('download', objectPath), '5-A test payload')
    await storageDenied('upload', objectPath, 'overwrite')
    assert.equal(await invoke('download', objectPath), '5-A test payload')
    await storageDenied('listFiles', `_emulatorChecks/${a}`)
  })
  await invoke('logout')
  await check('signed_out_clients_cannot_read_firestore_or_storage', async () => {
    await firestoreDenied('get', artwork)
    await storageDenied('download', objectPath)
    await storageDenied('deleteFile', objectPath)
  })
  assert.equal(await invoke('login', bLogin.email, password), b)
  await check('other_uid_cannot_read_or_delete_existing_storage_object', async () => {
    await storageDenied('download', objectPath)
    await storageDenied('deleteFile', objectPath)
  })
  assert.equal(await invoke('login', aLogin.email, password), a)
  await check('storage_owner_can_remove_the_test_object', async () => {
    await invoke('deleteFile', objectPath)
    await assert.rejects(invoke('download', objectPath), { code: 'storage/object-not-found' })
  })
  await check('no_browser_errors_or_non_emulator_requests', async () => {
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(externalRequests, [])
  })
} catch (error) {
  results.push({ name: 'test_run', status: 'failed', code: error.code, message: error.message })
  console.error(error)
  process.exitCode = 1
} finally {
  async function clean(url, init, label) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) })
      if (!response.ok && response.status !== 404) cleanupErrors.push(`${label}: HTTP ${response.status}`)
    } catch { cleanupErrors.push(`${label}: request failed`) }
  }
  // 실패 시에도 이 실행의 격리된 fixture만 지운다.
  for (const path of writtenObjects) {
    await clean(`http://127.0.0.1:${ports.storage}/v0/b/${bucket}/o/${encodeURIComponent(path)}`,
      { method: 'DELETE', headers: admin }, 'test object')
  }
  for (const path of writtenDocs.reverse()) await clean(`${documents}/${path}`, { method: 'DELETE', headers: admin }, 'test document')
  for (const uid of users) {
    await clean(`${documents}/users/${uid}`, { method: 'DELETE', headers: admin }, 'test profile')
    await clean(`http://127.0.0.1:${ports.auth}/identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:delete`,
      { method: 'POST', headers: { ...admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ localId: uid }) },
      'test account')
  }
  await browser?.close()
  await server?.close()
  if (cleanupErrors.length) process.exitCode = 1
  const summary = { results, externalRequests, pageErrors, cleanupErrors }
  await writeFile(join(outputDir, 'report.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify({
    passed: results.filter(test => test.status === 'passed').length,
    failed: results.filter(test => test.status === 'failed').length, cleanupErrors, outputDir,
  }))
}
