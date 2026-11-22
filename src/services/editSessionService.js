import { doc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { getSessionIdToken, waitForAuthSession } from './authSession'
import { readServerDocument } from './firestoreRead'

const openEditors = new Map()
const grants = new Map()
const registrations = new Map()
export const EDIT_SESSION_INVALIDATED = 'intelligentcanvas:edit-session-invalidated'
export const isConnectionFailure = error => [
  'sync/offline', 'functions/unavailable', 'functions/deadline-exceeded', 'functions/internal',
  'unavailable', 'deadline-exceeded', 'firestore/unavailable', 'firestore/deadline-exceeded', 'auth/network-request-failed',
].includes(error?.code) || error instanceof TypeError || error?.name === 'TimeoutError'
const isReload = globalThis.performance?.getEntriesByType('navigation')[0]?.type === 'reload'
const keyFor = (uid, artworkId) => `intelligentcanvas:editing:${uid}:${artworkId}`

function read(storage, key) {
  try { return globalThis[storage].getItem(key) } catch { return null }
}

function rememberRegistration(key, kind) {
  registrations.set(key, kind)
  try { localStorage.setItem(`${key}:kind`, kind) } catch { /* 분류는 현재 페이지에서 계속 사용할 수 있다. */ }
}

export function rememberNewLocalArtwork(uid, artworkId) {
  rememberRegistration(keyFor(uid, artworkId), 'local')
}

export function rememberServerArtwork(uid, artworkId) {
  rememberRegistration(keyFor(uid, artworkId), 'server')
}

export async function getArtworkKind(uid, artworkId) {
  const key = keyFor(uid, artworkId)
  const known = registrations.get(key) ?? read('localStorage', `${key}:kind`)
  if (!navigator.onLine) {
    if (known === 'local' || known === 'server') return known
    throw readOnlyError()
  }
  const { auth, db } = await import('../config/firebase')
  await waitForAuthSession(auth)
  const user = auth.currentUser
  if (user?.uid !== uid) throw readOnlyError()
  await getSessionIdToken(auth, user)
  if (auth.currentUser !== user) throw readOnlyError()
  const snapshot = await readServerDocument(doc(db, 'users', uid, 'artworks', artworkId), 'sync/offline', 7000)
  if (auth.currentUser !== user) throw readOnlyError()
  if (snapshot.exists()) {
    if (snapshot.get('ownerUid') !== uid || snapshot.get('state') === 'deleted') throw readOnlyError()
    rememberRegistration(key, 'server')
    return 'server'
  }
  // 한 번 서버에서 확인된 작품을 조회 실패나 누락으로 로컬 전용으로 바꾸지 않는다.
  if (known === 'server' || registrations.get(key) === 'server'
    || read('localStorage', `${key}:kind`) === 'server') throw readOnlyError()
  rememberRegistration(key, 'local')
  return 'local'
}

export function bindArtworkAccess(uid, artworkId) {
  const key = keyFor(uid, artworkId)
  const binding = { writable: false, syncing: false }
  openEditors.set(key, binding)
  return {
    setWritable(writable) { binding.writable = writable },
    setSyncing(syncing) { binding.syncing = syncing },
    close() { if (openEditors.get(key) === binding) openEditors.delete(key) },
  }
}

export function canSyncOpenArtwork(uid, artworkId) {
  return openEditors.get(keyFor(uid, artworkId))?.syncing === true
}

export function canWriteOpenArtwork(uid, artworkId) {
  return openEditors.get(keyFor(uid, artworkId))?.writable === true
}

function readOnlyError() {
  return Object.assign(new Error('편집 권한이 확인되지 않아 읽기 전용입니다.'), { code: 'artwork/read-only' })
}

// DB 트랜잭션을 열기 전에 확인하고, 커밋 직전에는 같은 편집기 권한을 동기로 확인한다.
export async function artworkWriteGuard(uid, artworkId) {
  const key = keyFor(uid, artworkId)
  const binding = openEditors.get(key)
  if (binding ? !binding.writable : await getArtworkKind(uid, artworkId) !== 'local') throw readOnlyError()
  return () => {
    if (openEditors.get(key) !== binding || (binding && !binding.writable)) throw readOnlyError()
  }
}

export function readTabGrant(uid, artworkId) {
  const key = keyFor(uid, artworkId)
  if (grants.has(key)) return grants.get(key)
  // 새 탐색이나 opener가 복제한 sessionStorage를 세션 인계에 사용하지 않는다.
  if (!isReload || window.opener) {
    storeTabGrant(uid, artworkId, null)
    return null
  }
  try {
    const proof = JSON.parse(read('sessionStorage', key))
    const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
    if (proof && validId(proof.sessionId) && validId(proof.deviceId) && Number.isSafeInteger(proof.generation)
      && proof.generation > 0 && typeof proof.token === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(proof.token)
      && Object.keys(proof).length === 4) {
      grants.set(key, proof)
      return proof
    }
  } catch { /* 복구 자격 증명이 손상됐으면 확인 전까지 읽기 전용으로 연다. */ }
  return null
}

let deviceId
export function getDeviceId() {
  if (!deviceId) {
    const key = 'intelligentcanvas:device-id'
    deviceId = read('localStorage', key) || crypto.randomUUID()
    try { localStorage.setItem(key, deviceId) } catch { /* 기기 ID는 인증에 사용하지 않는다. */ }
  }
  return deviceId
}

export function storeTabGrant(uid, artworkId, proof) {
  const key = keyFor(uid, artworkId)
  grants.set(key, proof)
  try {
    if (proof) sessionStorage.setItem(key, JSON.stringify(proof))
    else sessionStorage.removeItem(key)
  } catch { /* 동일 문서에서는 메모리 자격 증명을 유지한다. */ }
}

export function claimArtworkTab(uid, artworkId) {
  if (!navigator.locks) return Promise.resolve(null)
  return new Promise(resolve => {
    navigator.locks.request(keyFor(uid, artworkId), { ifAvailable: true }, lock => {
      if (!lock) return resolve(null)
      return new Promise(unlock => resolve(unlock))
    }).catch(() => resolve(null))
  })
}

export async function callEditSession(name, artworkId, input = {}) {
  if (!navigator.onLine) throw offlineError()
  const { auth } = await import('../config/firebase')
  const { functions } = await import('../config/firebaseServices')
  await waitForAuthSession(auth)
  const user = auth.currentUser
  if (user) await getSessionIdToken(auth, user)
  if (auth.currentUser !== user) throw readOnlyError()
  return (await httpsCallable(functions, name, { timeout: name === 'finalizeArtworkSave' ? 60000 : 10000 })({ artworkId, ...input })).data
}

function offlineError() {
  return Object.assign(new Error('온라인에서 편집 세션을 확인해 주세요.'), { code: 'sync/offline' })
}
