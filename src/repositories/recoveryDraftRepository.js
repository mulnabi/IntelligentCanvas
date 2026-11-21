import { localDb } from '../db/localDb'
import { rememberNewLocalArtwork } from '../services/editSessionService'
import { assertUser, MAX_ARTWORK_TITLE_LENGTH, readArtwork, scopedAuth } from './artworkRepository'

export const RECOVERY_MESSAGE = '이전 편집 세션이 무효화되었습니다. 이 브라우저의 원본은 보존되며 서버로 보내지 않습니다.'

export async function preserveRevokedArtwork(uid, artworkId, previous) {
  const auth = await scopedAuth(uid)
  const key = [uid, artworkId]
  const draftId = JSON.stringify([...key, previous.sessionId, previous.generation])
  const { artworks, artworkSync, syncQueue, layers, layerContents, recoveryDrafts } = localDb
  return localDb.transaction('rw', [artworks, artworkSync, syncQueue, layers, layerContents, recoveryDrafts], async () => {
    const artwork = await readArtwork(auth, uid, artworkId)
    const [state, queued, existing] = await Promise.all([
      artworkSync.get(key), syncQueue.get(key), recoveryDrafts.get(draftId),
    ])
    if (!state || state.sessionId !== previous.sessionId || state.generation !== previous.generation) return null
    let draft = existing
    if (!draft && (queued || state.localVersion !== state.ackLocalVersion)) {
      const snapshot = await layers.where('[uid+artworkId]').equals(key).sortBy('sortOrder')
      const originals = await layerContents.bulkGet(snapshot.map(({ layerId }) => [...key, layerId]))
      draft = { draftId, uid, artworkId, previousSessionId: previous.sessionId, previousGeneration: previous.generation,
        createdAt: Date.now(), reason: 'session_invalidated', localVersion: state.localVersion,
        pendingRequestIds: queued?.requestId ? [queued.requestId] : [],
        artworkMetadataSnapshot: artwork, layersSnapshot: snapshot, layerContentsSnapshot: originals.filter(Boolean),
        status: 'preserved' }
      await recoveryDrafts.add(draft)
    }
    if (queued && queued.state !== 'quarantined') await syncQueue.update(key, { state: 'quarantined' })
    await artworkSync.update(key, { failure: { revoked: true, terminal: true, message: RECOVERY_MESSAGE } })
    assertUser(auth, uid)
    return draft?.draftId ?? null
  })
}

export async function listRecoveryDrafts(uid, artworkId) {
  const auth = await scopedAuth(uid)
  const drafts = await localDb.recoveryDrafts.where('[uid+artworkId]').equals([uid, artworkId]).toArray()
  assertUser(auth, uid)
  return drafts.sort((a, b) => b.createdAt - a.createdAt).map(({ layerContentsSnapshot: _pngs, ...draft }) => draft)
}

export async function getRecoveryDraft(uid, artworkId, draftId) {
  const auth = await scopedAuth(uid)
  const draft = await localDb.recoveryDrafts.get(draftId)
  assertUser(auth, uid)
  if (draft?.uid !== uid || draft.artworkId !== artworkId) throw new Error('이 계정의 복구 초안을 찾을 수 없습니다.')
  return draft
}

export async function copyRecoveryDraft(uid, artworkId, draftId) {
  const auth = await scopedAuth(uid)
  const { artworkMetadataSnapshot, layersSnapshot, layerContentsSnapshot } = await getRecoveryDraft(uid, artworkId, draftId)
  const copyId = crypto.randomUUID()
  const suffix = ' (복구본)'
  const title = artworkMetadataSnapshot.title.slice(0, MAX_ARTWORK_TITLE_LENGTH - suffix.length).trimEnd() + suffix
  const now = Date.now()
  const scope = { uid, artworkId: copyId }
  await localDb.transaction('rw', localDb.artworks, localDb.layers, localDb.layerContents, async () => {
    assertUser(auth, uid)
    const { serverDeletedVersion: _deletedVersion, ...original } = artworkMetadataSnapshot
    await localDb.artworks.add({ ...original, ...scope, title, titleNormalized: title.normalize('NFKC').toLowerCase(),
      createdAt: now, updatedAt: now, state: 'active', deletedAt: null })
    await localDb.layers.bulkAdd(layersSnapshot.map(layer => ({ ...layer, ...scope })))
    await localDb.layerContents.bulkAdd(layerContentsSnapshot.map(content => ({ ...content, ...scope })))
    assertUser(auth, uid)
  })
  rememberNewLocalArtwork(uid, copyId)
  return copyId
}
