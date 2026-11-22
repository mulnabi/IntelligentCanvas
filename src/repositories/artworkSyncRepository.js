import Dexie from 'dexie'
import { localDb } from '../db/localDb'

const key = (uid, artworkId) => [uid, artworkId]
const error = message => Object.assign(new Error(message), { code: 'sync/conflict' })
const rows = (table, uid, id) => table.where('[uid+artworkId+layerId]')
  .between([uid, id, Dexie.minKey], [uid, id, Dexie.maxKey], true, true)
const pending = (uid, artworkId) => ({ uid, artworkId, state: 'pending' })
const sameEpoch = (state, proof) => state.sessionId === proof.sessionId && state.generation === proof.generation
export const SERVER_PNG_LIMIT = 8 * 1024 * 1024
const legacySizeMessage = '서버에 올릴 레이어 PNG는 각각 8 MiB 이하여야 합니다.'
export const isOversizeFailure = failure => failure?.code === 'sync/size' || failure?.terminal === true && failure.message === legacySizeMessage

async function proofDigest(proof) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(proof.token))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function canResumeVerifiedEpoch(state, proof) {
  return !!(state?.verifiedProof && proof && sameEpoch(state, proof) && state.verifiedProof === await proofDigest(proof))
}

export const readArtworkSync = (uid, artworkId) => localDb.artworkSync.get(key(uid, artworkId))

export async function cachedServerArtworkIds(uid) {
  const states = await localDb.artworkSync.where('[uid+artworkId]')
    .between([uid, Dexie.minKey], [uid, Dexie.maxKey], true, true).toArray()
  return states.filter(row => row.serverVersion !== null && !row.serverDeletedVersion).map(row => row.artworkId)
}

export async function checkServerDeleteTarget(uid, artworkId) {
  return localDb.transaction('r', localDb.artworkSync, localDb.syncQueue, localDb.recoveryDrafts, async () => {
    const scope = key(uid, artworkId)
    const [state, queued, drafts] = await Promise.all([readArtworkSync(uid, artworkId), localDb.syncQueue.get(scope),
      localDb.recoveryDrafts.where('[uid+artworkId]').equals(scope).count()])
    if (queued || drafts || state && (state.localVersion !== state.ackLocalVersion || state.failure?.revoked)) {
      throw error('이 브라우저에 미동기화 작업 또는 복구 초안이 있어 서버 작품을 삭제할 수 없습니다.')
    }
    return state
  })
}

export function rememberServerDeletions(uid, markers, checkUser) {
  return localDb.transaction('rw', localDb.artworks, localDb.artworkSync, async () => {
    checkUser()
    for (const { artworkId, serverVersion } of markers) {
      const scope = key(uid, artworkId)
      // 목록에만 있던 작품의 표식도 남겨 진행 중이던 이전 버전 다운로드를 차단한다.
      const state = await localDb.artworkSync.get(scope) ?? { uid, artworkId, serverVersion: null, localVersion: 0, ackLocalVersion: 0 }
      if ((state.serverDeletedVersion ?? 0) >= serverVersion) continue
      await localDb.artworkSync.put({ ...state, serverDeletedVersion: serverVersion })
      await localDb.artworks.update(scope, { serverDeletedVersion: serverVersion })
    }
    checkUser()
  })
}

export function toServerMeta(artwork) {
  return { title: artwork.title, widthPx: artwork.width, heightPx: artwork.height, backgroundColor: artwork.backgroundColor }
}

export async function requestRegistration(uid, artworkId) {
  await localDb.transaction('rw', localDb.artworkSync, localDb.syncQueue, async () => {
    if (await readArtworkSync(uid, artworkId)) return
    await localDb.artworkSync.add({ uid, artworkId, serverVersion: null, localVersion: 1, ackLocalVersion: 0 })
    await localDb.syncQueue.add(pending(uid, artworkId))
  })
}

export async function confirmRegistration(uid, artworkId) {
  await localDb.artworkSync.update(key(uid, artworkId), { serverVersion: 0 })
}

// 기존 작품 / PNG 변경과 같은 Dexie 트랜잭션 안에서 호출한다.
export async function noteArtworkChange(uid, artworkId) {
  const current = await readArtworkSync(uid, artworkId)
  if (!current) return
  await localDb.artworkSync.update(key(uid, artworkId), { localVersion: current.localVersion + 1 })
  if (!await localDb.syncQueue.get(key(uid, artworkId))) await localDb.syncQueue.add(pending(uid, artworkId))
}

export function checkSyncEpoch(state, proof) {
  if (state?.serverDeletedVersion || state?.failure?.revoked
    || (state?.sessionId && !sameEpoch(state, proof) && state.localVersion !== state.ackLocalVersion)) {
    throw error('이전 편집 세션의 미동기화 그림이 남아 있습니다. 이 브라우저의 그림을 보존했습니다.')
  }
}

export async function startSyncEpoch(uid, artworkId, proof) {
  const verifiedProof = await proofDigest(proof)
  await localDb.transaction('rw', localDb.artworkSync, localDb.syncQueue, async () => {
    const state = await readArtworkSync(uid, artworkId)
    if (!state) return
    checkSyncEpoch(state, proof)
    const same = sameEpoch(state, proof)
    if (!same || state.verifiedProof !== verifiedProof) {
      await localDb.artworkSync.update(key(uid, artworkId), { sessionId: proof.sessionId, generation: proof.generation, verifiedProof })
    }
    if (!same) await noteArtworkChange(uid, artworkId)
  })
}

export function freezeNextSave(uid, artworkId, proof) {
  return localDb.transaction('rw', [localDb.artworkSync, localDb.syncQueue, localDb.artworks, localDb.layers, localDb.layerContents], async () => {
    const [state, queued] = await Promise.all([readArtworkSync(uid, artworkId), localDb.syncQueue.get(key(uid, artworkId))])
    if (!state || state.serverDeletedVersion || !queued || queued.state === 'quarantined' || state.serverVersion === null) return null
    if (!sameEpoch(state, proof)) throw error('다른 세션의 변경을 보내지 않습니다.')
    if (queued.requestId) return queued
    const artwork = await localDb.artworks.get(key(uid, artworkId))
    if (artwork?.state !== 'active') throw error('이 브라우저에서 작품을 열 수 없습니다.')
    const layers = await rows(localDb.layers, uid, artworkId).toArray()
    // 읽기 전용 화면에서 막 편집 권한을 획득한 빈 작품은 첫 로컬 저장을 기다린다.
    if (!layers.length) return null
    const contents = await rows(localDb.layerContents, uid, artworkId).toArray()
    const job = { ...queued, requestId: crypto.randomUUID(), expectedServerVersion: state.serverVersion,
      localVersion: state.localVersion, sessionId: proof.sessionId, generation: proof.generation,
      meta: toServerMeta(artwork), layers: layers.sort((a, b) => a.sortOrder - b.sortOrder), contents }
    await localDb.syncQueue.put(job)
    return job
  })
}

export function replaceOversizeJob(uid, artworkId, proof, serverVersion, checkUser) {
  const scope = key(uid, artworkId)
  const { artworkSync, syncQueue, recoveryDrafts, artworks, layerContents } = localDb
  return localDb.transaction('rw', [artworkSync, syncQueue, recoveryDrafts, artworks, layerContents], async () => {
    checkUser()
    const [state, job, artwork, current] = await Promise.all([
      artworkSync.get(scope), syncQueue.get(scope), artworks.get(scope), rows(layerContents, uid, artworkId).toArray(),
    ])
    if (!state || state.serverDeletedVersion || !sameEpoch(state, proof) || state.serverVersion !== serverVersion
      || !job?.requestId || job.state === 'quarantined' || !sameEpoch(job, proof) || job.expectedServerVersion !== serverVersion
      || !isOversizeFailure(state.failure) || (state.failure.requestId && state.failure.requestId !== job.requestId)
      || !job.contents.some(row => row.pngBlob.size > SERVER_PNG_LIMIT) || artwork?.state !== 'active') {
      throw error('보존할 용량 초과 요청과 현재 편집 권한을 확인하지 못했습니다.')
    }
    if (state.localVersion <= job.localVersion || current.some(row => row.pngBlob.size > SERVER_PNG_LIMIT)) {
      throw error('8 MiB를 넘는 레이어를 수정한 뒤 로컬 저장이 끝나면 다시 시도해 주세요.')
    }
    const draftId = JSON.stringify([...scope, 'png_size', job.requestId])
    const { title, widthPx: width, heightPx: height, backgroundColor } = job.meta
    await recoveryDrafts.add({
      draftId, uid, artworkId, previousSessionId: job.sessionId, previousGeneration: job.generation,
      createdAt: Date.now(), reason: 'png_size', localVersion: job.localVersion, pendingRequestIds: [job.requestId],
      artworkMetadataSnapshot: { ...artwork, title, width, height, backgroundColor },
      layersSnapshot: job.layers, layerContentsSnapshot: job.contents, failedJob: job, status: 'preserved',
    })
    await syncQueue.put(pending(uid, artworkId))
    await artworkSync.update(scope, { failure: null })
    checkUser()
  })
}

export async function acknowledgeSave(uid, artworkId, job, receipt) {
  if (receipt?.requestId !== job.requestId || receipt.localVersion !== job.localVersion
    || receipt.serverVersion !== job.expectedServerVersion + 1) throw error('서버 저장 영수증을 확인할 수 없습니다.')
  await localDb.transaction('rw', localDb.artworkSync, localDb.syncQueue, async () => {
    const [state, current] = await Promise.all([readArtworkSync(uid, artworkId), localDb.syncQueue.get(key(uid, artworkId))])
    if (!state || state.serverDeletedVersion || current?.state === 'quarantined' || current?.requestId !== job.requestId
      || state.serverVersion !== job.expectedServerVersion) {
      throw error('대기열이 변경되어 저장 결과를 다시 확인해야 합니다.')
    }
    await localDb.artworkSync.update(key(uid, artworkId), {
      serverVersion: receipt.serverVersion, ackLocalVersion: receipt.localVersion, receipt, failure: null,
    })
    if (state.localVersion === receipt.localVersion) await localDb.syncQueue.delete(key(uid, artworkId))
    else await localDb.syncQueue.put(pending(uid, artworkId))
  })
}

export async function getSyncConfirmation(uid, artworkId, proof) {
  return localDb.transaction('r', localDb.artworkSync, localDb.syncQueue, async () => {
    const [state, next] = await Promise.all([readArtworkSync(uid, artworkId), localDb.syncQueue.get(key(uid, artworkId))])
    if (!state || !sameEpoch(state, proof) || next || !state.receipt
      || state.localVersion !== state.ackLocalVersion || state.receipt.localVersion !== state.localVersion
      || state.receipt.serverVersion !== state.serverVersion) throw error('최신 서버 저장 확정을 확인한 뒤 편집을 종료해 주세요.')
    return state.receipt
  })
}

export function checkDownloadTarget(artwork, state, queued) {
  if (state?.serverDeletedVersion) throw Object.assign(new Error('서버에서 삭제된 작품입니다.'), { code: 'sync/deleted' })
  if (queued || state?.failure?.revoked || artwork && (!state || state.localVersion !== state.ackLocalVersion || state.serverVersion === null
    || artwork.state !== 'active')) {
    throw error('이 브라우저에 미동기화 변경이 있어 서버 작품으로 덮어쓰지 않았습니다.')
  }
}

export async function installServerArtwork(uid, remote, blobs, checkUser) {
  const { artworkId, title, widthPx: width, heightPx: height, backgroundColor, createdAt, updatedAt, serverVersion } = remote
  await localDb.transaction('rw', [localDb.artworks, localDb.layers, localDb.layerContents, localDb.artworkSync, localDb.syncQueue], async () => {
    checkUser()
    const current = await localDb.artworks.get(key(uid, artworkId))
    const state = await readArtworkSync(uid, artworkId)
    checkDownloadTarget(current, state, await localDb.syncQueue.get(key(uid, artworkId)))
    if (state && state.serverVersion >= serverVersion) return
    await localDb.artworks.put({ uid, artworkId, title, titleNormalized: title.normalize('NFKC').toLowerCase(),
      width, height, backgroundColor, createdAt, updatedAt, state: 'active', schemaVersion: 1, deletedAt: null })
    await rows(localDb.layers, uid, artworkId).delete()
    await rows(localDb.layerContents, uid, artworkId).delete()
    await localDb.layers.bulkPut(remote.layers.map(({ layerId, name, sortOrder, opacity, visible, isTemporary, category }) =>
      ({ uid, artworkId, layerId, name, sortOrder, opacity, visible, isTemporary, category })))
    await localDb.layerContents.bulkPut([...blobs].map(([layerId, pngBlob]) =>
      ({ uid, artworkId, layerId, pngBlob, width, height, savedAt: updatedAt, schemaVersion: 1 })))
    await localDb.artworkSync.put({ uid, artworkId, serverVersion, localVersion: 0, ackLocalVersion: 0 })
    checkUser()
  })
}
