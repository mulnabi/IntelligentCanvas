import Dexie from 'dexie'
import { localDb } from '../db/localDb'
import { assertUser, readArtwork, scopedAuth } from './artworkRepository'
import { getCanvasContent, validatePngHeader } from './canvasRepository'

function layerError(message) {
  return Object.assign(new Error(message), { code: 'canvas/layers' })
}

export function createLayer(name) {
  return { layerId: crypto.randomUUID(), name, sortOrder: 0, opacity: 1, visible: true, isTemporary: false, category: null }
}

function listLayers(uid, artworkId) {
  return localDb.layers.where('[uid+artworkId+sortOrder]')
    .between([uid, artworkId, Dexie.minKey], [uid, artworkId, Dexie.maxKey]).toArray()
}

function prepareLayerRows(uid, artworkId, layers) {
  const ids = new Set()
  if (!Array.isArray(layers) || !layers.length) throw layerError('작품에는 레이어가 하나 이상 필요합니다.')
  return layers.map(({ layerId, name, opacity, visible, isTemporary, category }, sortOrder) => {
    if (typeof layerId !== 'string' || !layerId || ids.has(layerId) || typeof name !== 'string'
      || !Number.isFinite(opacity) || opacity < 0 || opacity > 1 || typeof visible !== 'boolean'
      || typeof isTemporary !== 'boolean' || !(category === null || typeof category === 'string')) {
      throw layerError('레이어 설정을 확인할 수 없습니다.')
    }
    ids.add(layerId)
    return { uid, artworkId, layerId, name, sortOrder, opacity, visible, isTemporary, category }
  })
}

async function readLayerDocument(auth, uid, artworkId) {
  return localDb.transaction('r', localDb.artworks, localDb.layers, localDb.layerContents, async () => {
    const artwork = await readArtwork(auth, uid, artworkId)
    const layers = await listLayers(uid, artworkId)
    const contents = (await localDb.layerContents.bulkGet(layers.map(({ layerId }) => [uid, artworkId, layerId]))).filter(Boolean)
    assertUser(auth, uid)
    return { artwork, layers, contents }
  })
}

async function validateContents(contents, artwork) {
  for (const { pngBlob, width, height, schemaVersion } of contents) {
    if (schemaVersion !== 1 || width !== artwork.width || height !== artwork.height) {
      throw layerError('저장한 레이어의 크기 또는 형식을 확인할 수 없습니다. 기존 그림은 유지됩니다.')
    }
    await validatePngHeader(pngBlob, width, height)
  }
}

// prepare는 PNG 디코딩과 메모리 확인을 끝낸다. 실패하면 이전 작업을 기록하지 않는다.
export async function openLayerDocument(uid, artworkId, { prepare, signal }) {
  const auth = await scopedAuth(uid)
  const existing = await readLayerDocument(auth, uid, artworkId)
  signal.throwIfAborted()
  if (existing.layers.length) {
    await validateContents(existing.contents, existing.artwork)
    await prepare(existing)
    signal.throwIfAborted()
    assertUser(auth, uid)
    return existing
  }

  const legacy = await getCanvasContent(uid, artworkId)
  signal.throwIfAborted()
  const layers = prepareLayerRows(uid, artworkId, [createLayer(legacy ? '기존 그림' : '레이어 1')])
  const contents = legacy ? [{ ...legacy, layerId: layers[0].layerId }] : []
  await prepare({ layers, contents })
  signal.throwIfAborted()
  const initialized = await localDb.transaction('rw', localDb.artworks, localDb.canvasContents, localDb.layers, localDb.layerContents, async () => {
    await readArtwork(auth, uid, artworkId)
    signal.throwIfAborted()
    if ((await listLayers(uid, artworkId)).length) return false
    const current = await localDb.canvasContents.get([uid, artworkId])
    if (current?.savedAt !== legacy?.savedAt || current?.pngBlob.size !== legacy?.pngBlob.size) {
      throw layerError('이전할 원본이 바뀌었습니다. 작품을 다시 불러와 주세요.')
    }
    await localDb.layers.add(layers[0])
    if (contents.length) await localDb.layerContents.add(contents[0])
    signal.throwIfAborted()
    assertUser(auth, uid)
    return true
  })
  if (initialized) return { layers, contents }
  // 동시 첫 열기에서 먼저 완료된 레이어 문서를 사용한다.
  return openLayerDocument(uid, artworkId, { prepare, signal })
}

export async function saveLayerChanges(uid, artworkId, { previousIds, layers, contents }) {
  const auth = await scopedAuth(uid)
  const rows = layers && prepareLayerRows(uid, artworkId, layers)
  for (const { pngBlob, width, height } of contents) await validatePngHeader(pngBlob, width, height)
  return localDb.transaction('rw', localDb.artworks, localDb.layers, localDb.layerContents, async () => {
    const artwork = await readArtwork(auth, uid, artworkId)
    const current = await listLayers(uid, artworkId)
    const expectedIds = new Set(previousIds)
    if (current.length !== expectedIds.size || current.some(layer => !expectedIds.has(layer.layerId))) {
      throw layerError('저장된 레이어 목록이 바뀌었습니다. 다른 탭을 닫고 작품을 다시 열어 주세요.')
    }
    const nextIds = new Set((rows ?? current).map(layer => layer.layerId))
    const savedAt = Date.now()
    const changed = contents.map(({ layerId, pngBlob, width, height }) => {
      if (!nextIds.has(layerId)) throw layerError('이 작품에 속한 레이어만 저장할 수 있습니다.')
      if (width !== artwork.width || height !== artwork.height) throw layerError('레이어 크기가 작품과 일치하지 않습니다.')
      return { uid, artworkId, layerId, pngBlob, width, height, savedAt, schemaVersion: 1 }
    })
    if (rows) {
      const removed = current.filter(({ layerId }) => !nextIds.has(layerId)).map(({ layerId }) => [uid, artworkId, layerId])
      await localDb.layers.bulkDelete(removed)
      await localDb.layerContents.bulkDelete(removed)
      await localDb.layers.bulkPut(rows)
    }
    if (changed.length) await localDb.layerContents.bulkPut(changed)
    await localDb.artworks.update([uid, artworkId], { updatedAt: savedAt })
    assertUser(auth, uid)
  })
}
