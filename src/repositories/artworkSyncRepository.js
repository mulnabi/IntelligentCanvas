import Dexie from 'dexie'
import { localDb } from '../db/localDb'

const key = (uid, artworkId) => [uid, artworkId]
const error = message => Object.assign(new Error(message), { code: 'sync/conflict' })
const rows = (table, uid, id) => table.where('[uid+artworkId+layerId]')
  .between([uid, id, Dexie.minKey], [uid, id, Dexie.maxKey], true, true)
const pending = (uid, artworkId) => ({ uid, artworkId, state: 'pending' })
const sameEpoch = (state, proof) => state.sessionId === proof.sessionId && state.generation === proof.generation

async function proofDigest(proof) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(proof.token))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function canResumeVerifiedEpoch(state, proof) {
  return !!(state?.verifiedProof && proof && sameEpoch(state, proof) && state.verifiedProof === await proofDigest(proof))
}

export const readArtworkSync = (uid, artworkId) => localDb.artworkSync.get(key(uid, artworkId))

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
  if (state?.failure?.revoked
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
    if (!state || !queued || queued.state === 'quarantined' || state.serverVersion === null) return null
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

export async function acknowledgeSave(uid, artworkId, job, receipt) {
  if (receipt?.requestId !== job.requestId || receipt.localVersion !== job.localVersion
    || receipt.serverVersion !== job.expectedServerVersion + 1) throw error('서버 저장 영수증을 확인할 수 없습니다.')
  await localDb.transaction('rw', localDb.artworkSync, localDb.syncQueue, async () => {
    const [state, current] = await Promise.all([readArtworkSync(uid, artworkId), localDb.syncQueue.get(key(uid, artworkId))])
    if (!state || current?.state === 'quarantined' || current?.requestId !== job.requestId
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
