import { httpsCallable } from 'firebase/functions'
import { localDb } from '../db/localDb'
import { getArtwork, scopedAuth, assertUser } from '../repositories/artworkRepository'
import { validatePngHeader } from '../repositories/canvasRepository'
import { acknowledgeSave, checkDownloadTarget, confirmRegistration, freezeNextSave, installServerArtwork,
  readArtworkSync, requestRegistration, toServerMeta } from '../repositories/artworkSyncRepository'
import { callEditSession, canSyncOpenArtwork, EDIT_SESSION_INVALIDATED, isConnectionFailure, rememberServerArtwork } from './editSessionService'

const active = new Map()
const maxPngBytes = 8 * 1024 * 1024
const error = (code, message) => Object.assign(new Error(message), { code })
const conflict = () => error('sync/conflict', '서버 버전 또는 편집 권한이 변경되었습니다. 로컬 그림을 보존했습니다.')

async function digest(blob) {
  if (blob.size > maxPngBytes) throw error('sync/size', '서버에 올릴 레이어 PNG는 각각 8 MiB 이하여야 합니다.')
  const bytes = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function binary(name, uid, query, body, proof, signal) {
  const auth = await scopedAuth(uid)
  const { app, firebaseEmulators } = await import('../config/firebase')
  const { functionsRegion } = await import('../config/firebaseServerEmulators')
  const token = await auth.currentUser.getIdToken()
  assertUser(auth, uid)
  if (proof && !canSyncOpenArtwork(uid, query.artworkId)) throw conflict()
  const endpoint = new URL(`http://127.0.0.1:${firebaseEmulators.functionsPort}/${app.options.projectId}/${functionsRegion}/${name}`)
  endpoint.search = new URLSearchParams(query)
  const headers = { Authorization: `Bearer ${token}` }
  if (body) Object.assign(headers, { 'Content-Type': 'image/png', 'X-Edit-Proof': JSON.stringify(proof) })
  const timeout = AbortSignal.timeout(60000)
  const response = await fetch(endpoint, { method: body ? 'POST' : 'GET', body, headers,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  if (!response.ok) {
    const result = await response.json().catch(() => ({}))
    throw error(`functions/${result.code || 'unavailable'}`, result.message || '서버 파일 요청이 실패했습니다.')
  }
  assertUser(auth, uid)
  return body ? response.json() : response.blob()
}

export async function registerServerArtwork(uid, artworkId) {
  const auth = await scopedAuth(uid)
  const artwork = await getArtwork(uid, artworkId)
  await requestRegistration(uid, artworkId)
  const state = await readArtworkSync(uid, artworkId)
  if (state.serverVersion !== null) return state
  assertUser(auth, uid)
  const registration = await callEditSession('createServerArtwork', artworkId, { meta: toServerMeta(artwork) })
  if (registration.publication !== 'pending' || registration.serverVersion !== 0) throw conflict()
  assertUser(auth, uid)
  await confirmRegistration(uid, artworkId)
  rememberServerArtwork(uid, artworkId)
  return readArtworkSync(uid, artworkId)
}

export async function syncBaseline(uid, artworkId) {
  const state = await readArtworkSync(uid, artworkId)
  // 응답을 잃었어도 명시적으로 서버 등록을 요청해 둔 작업만 재확인한다.
  return state?.serverVersion === null ? registerServerArtwork(uid, artworkId) : state
}

async function sendJob(uid, artworkId, proof, job, auth) {
  const status = await callEditSession('getEditSessionStatus', artworkId, { proof, details: true })
  if (status.status !== 'held') throw error('sync/revoked', '이전 편집 세션이 무효화되었습니다.')
  const copies = new Map(job.contents.map(row => [row.layerId, row.pngBlob]))
  const layers = []
  for (const { layerId, name, opacity, visible, isTemporary, category } of job.layers) {
    const png = copies.get(layerId)
    layers.push({ layerId, name, opacity, visible, isTemporary, category,
      image: png ? { hash: await digest(png), size: png.size } : null })
  }
  const { requestId, expectedServerVersion, localVersion, meta } = job
  const request = { proof, requestId }
  assertUser(auth, uid)
  if (!canSyncOpenArtwork(uid, artworkId)) throw conflict()
  // 응답을 잃은 성공 요청은 버전이 앞서도 같은 영수증을 돌려받는다.
  // 그 외 버전 불일치는 서버의 prepare에서 업로드 전에 거부된다.
  const start = await callEditSession('prepareArtworkSave', artworkId, { ...request, expectedServerVersion, localVersion, meta, layers })
  if (start.committed) return start.committed
  if (status.serverVersion !== expectedServerVersion) throw conflict()
  for (const layerId of start.uploadLayerIds) {
    if (!copies.has(layerId)) throw conflict()
    await binary('uploadArtworkPng', uid, { artworkId, requestId, layerId }, copies.get(layerId), proof)
  }
  await scopedAuth(uid)
  if (!canSyncOpenArtwork(uid, artworkId)) throw conflict()
  return callEditSession('finalizeArtworkSave', artworkId, request)
}

const fatal = new Set(['functions/failed-precondition', 'functions/permission-denied', 'functions/invalid-argument',
  'functions/not-found', 'sync/size', 'sync/conflict'])

export function syncArtwork(uid, artworkId, proof) {
  const key = JSON.stringify([uid, artworkId])
  if (active.has(key)) return active.get(key)
  const work = async () => {
    const auth = await scopedAuth(uid)
    if (!navigator.onLine) throw error('sync/offline', '온라인에서 서버 동기화를 다시 시도해 주세요.')
    try {
      while (canSyncOpenArtwork(uid, artworkId)) {
        const state = await readArtworkSync(uid, artworkId)
        if (!state || state.failure?.terminal) return
        const job = await freezeNextSave(uid, artworkId, proof)
        if (!job) return
        assertUser(auth, uid)
        const receipt = await sendJob(uid, artworkId, proof, job, auth)
        assertUser(auth, uid)
        if (!canSyncOpenArtwork(uid, artworkId)) return
        await acknowledgeSave(uid, artworkId, job, receipt)
      }
    } catch (cause) {
      assertUser(auth, uid)
      // 화면을 떠난 경우 다음 진입에서 동일 요청을 이어 간다.
      if (!canSyncOpenArtwork(uid, artworkId)) return
      const rejected = ['sync/revoked', 'functions/permission-denied', 'functions/failed-precondition', 'functions/not-found'].includes(cause.code)
      if (rejected) window.dispatchEvent(new CustomEvent(EDIT_SESSION_INVALIDATED, {
        detail: { uid, artworkId, generation: proof.generation, confirmed: cause.code === 'sync/revoked' },
      }))
      const terminal = rejected || fatal.has(cause.code)
      const message = terminal ? cause.message : '서버 저장을 확인하지 못했습니다. 로컬 저장본을 보존했습니다.'
      await localDb.transaction('rw', localDb.artworkSync, async () => {
        const state = await readArtworkSync(uid, artworkId)
        if (!state?.failure?.revoked) {
          const connection = isConnectionFailure(cause)
          const attempts = connection ? (state.failure?.attempts ?? 0) + 1 : 0
          await localDb.artworkSync.update([uid, artworkId], { failure: { terminal, message, connection, attempts } })
        }
      })
      throw cause
    }
  }
  const running = work().finally(() => active.delete(key))
  active.set(key, running)
  return running
}

export async function listServerArtworks(uid) {
  const auth = await scopedAuth(uid)
  const { functions } = await import('../config/firebaseServerEmulators')
  const { data } = await httpsCallable(functions, 'listServerArtworks', { timeout: 10000 })({})
  assertUser(auth, uid)
  return data
}

async function getConfirmedArtwork(auth, uid, artworkId) {
  const remote = await callEditSession('getServerArtwork', artworkId)
  assertUser(auth, uid)
  return remote
}

async function downloadConfirmedLayers(uid, remote, signal) {
  const { artworkId, serverVersion, widthPx, heightPx } = remote
  const blobs = new Map()
  for (const { layerId, image } of remote.layers) {
    if (!image) continue
    const blob = await binary('downloadArtworkPng', uid, { artworkId, layerId, version: serverVersion }, undefined, undefined, signal)
    await validatePngHeader(blob, widthPx, heightPx)
    if (blob.size !== image.size || await digest(blob) !== image.hash) throw error('sync/integrity', '다운로드한 PNG의 무결성이 일치하지 않습니다.')
    const bitmap = await createImageBitmap(blob)
    bitmap.close()
    blobs.set(layerId, blob)
  }
  signal?.throwIfAborted()
  return blobs
}

// 서버 확정본을 화면에만 제공한다. 수정 중이거나 무효화된 로컬 작업본과 대기열은 건드리지 않는다.
export async function loadServerArtworkSnapshot(uid, artworkId, signal) {
  const auth = await scopedAuth(uid)
  signal.throwIfAborted()
  const remote = await getConfirmedArtwork(auth, uid, artworkId)
  signal.throwIfAborted()
  const blobs = await downloadConfirmedLayers(uid, remote, signal)
  assertUser(auth, uid)
  const { widthPx: width, heightPx: height, title, backgroundColor, serverVersion, layers } = remote
  const contents = [...blobs].map(([layerId, pngBlob]) => ({ layerId, pngBlob }))
  return { artwork: { uid, artworkId, title, width, height, backgroundColor }, serverVersion, layers, contents }
}

export async function downloadServerArtwork(uid, artworkId) {
  const auth = await scopedAuth(uid)
  const key = [uid, artworkId]
  const state = await readArtworkSync(uid, artworkId)
  checkDownloadTarget(await localDb.artworks.get(key), state, await localDb.syncQueue.get(key))
  const remote = await getConfirmedArtwork(auth, uid, artworkId)
  if (state?.serverVersion >= remote.serverVersion) return remote
  const blobs = await downloadConfirmedLayers(uid, remote)
  await installServerArtwork(uid, remote, blobs, () => assertUser(auth, uid))
  rememberServerArtwork(uid, artworkId)
  return remote
}
