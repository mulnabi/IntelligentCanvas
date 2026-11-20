import { localDb } from '../db/localDb'
import { assertUser, getArtworkErrorMessage, MAX_ARTWORK_DIMENSION, readArtwork, scopedAuth } from './artworkRepository'

// 전체 PNG를 다루는 이번 단계의 파일 한도이며 기기의 Canvas 지원 보장은 아니다.
export const MAX_CANVAS_PNG_BYTES = 128 * 1024 * 1024

function canvasError(code, message) {
  return Object.assign(new Error(message), { code })
}

export function getCanvasErrorMessage(error) {
  if (error?.code?.startsWith('canvas/')) return error.message
  return getArtworkErrorMessage(error)
}

function validateDimensions(width, height) {
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= MAX_ARTWORK_DIMENSION)) {
    throw canvasError('canvas/invalid-size', '저장할 그림의 픽셀 크기가 올바르지 않습니다. 작품을 다시 열어 주세요.')
  }
}

function validateBlob(pngBlob) {
  if (!(pngBlob instanceof Blob) || pngBlob.type !== 'image/png' || pngBlob.size < 33) {
    throw canvasError('canvas/invalid-png', '유효한 PNG 그림을 만들거나 읽지 못했습니다. 다시 시도해 주세요.')
  }
  if (pngBlob.size > MAX_CANVAS_PNG_BYTES) {
    throw canvasError('canvas/png-too-large', 'PNG 파일이 너무 커서 저장할 수 없습니다. 현재 그림은 화면에 남아 있습니다. 이번 편집기에서는 더 작은 크기의 작품을 사용해 주세요.')
  }
}

export async function validatePngHeader(pngBlob, width, height) {
  validateDimensions(width, height)
  validateBlob(pngBlob)
  // Blob 읽기는 IndexedDB 트랜잭션 밖에서 끝낸다. 실제 이미지 디코딩은 Canvas 측에서 처리한다.
  const bytes = new Uint8Array(await pngBlob.slice(0, 33).arrayBuffer())
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const isPng = signature.every((value, index) => bytes[index] === value)
    && view.getUint32(8) === 13
    && [73, 72, 68, 82].every((value, index) => bytes[12 + index] === value)
  if (!isPng) throw canvasError('canvas/invalid-png', '저장된 그림의 PNG 형식을 확인하지 못했습니다. 기존 데이터는 유지됩니다.')
  if (view.getUint32(16) !== width || view.getUint32(20) !== height) {
    throw canvasError('canvas/size-mismatch', 'PNG 해상도와 작품 크기가 다릅니다. 기존 그림을 늘이거나 잘라서 저장하지 않습니다.')
  }
}

function assertContentSize(artwork, width, height) {
  if (artwork.width !== width || artwork.height !== height) {
    throw canvasError('canvas/size-mismatch', '작품 정보와 그림 크기가 다릅니다. 작품을 다시 열어 주세요.')
  }
}

export async function getCanvasContent(uid, artworkId) {
  const auth = await scopedAuth(uid)
  const content = await localDb.transaction('r', localDb.artworks, localDb.canvasContents, async () => {
    const artwork = await readArtwork(auth, uid, artworkId)
    const saved = await localDb.canvasContents.get([uid, artworkId])
    assertUser(auth, uid)
    if (!saved) return null // v1 작품 및 아직 한 번도 그리지 않은 작품은 정상적인 빈 그림.
    if (saved.uid !== uid || saved.artworkId !== artworkId || saved.schemaVersion !== 1) {
      throw canvasError('canvas/invalid-content', '저장된 그림 정보를 확인할 수 없습니다. 기존 데이터는 유지됩니다.')
    }
    assertContentSize(artwork, saved.width, saved.height)
    return saved
  })
  if (content) await validatePngHeader(content.pngBlob, content.width, content.height)
  assertUser(auth, uid)
  return content
}

export async function saveCanvasContent(uid, artworkId, { pngBlob, width, height }) {
  const auth = await scopedAuth(uid)
  // toBlob()과 Blob 헤더 읽기를 모두 끝낸 뒤 쓰기 트랜잭션을 연다.
  await validatePngHeader(pngBlob, width, height)
  assertUser(auth, uid)
  return localDb.transaction('rw', localDb.artworks, localDb.canvasContents, async () => {
    const artwork = await readArtwork(auth, uid, artworkId)
    assertContentSize(artwork, width, height)
    const savedAt = Date.now() // 로컬 시각. 서버 Timestamp/서버 저장 확정이 아니다.
    const content = { uid, artworkId, pngBlob, width, height, savedAt, schemaVersion: 1 }
    await localDb.canvasContents.put(content)
    await localDb.artworks.update([uid, artworkId], { updatedAt: savedAt })
    assertUser(auth, uid)
    // 두 쓰기가 모두 성공한 경우에만 커밋한다. 실패하면 이전 PNG와 updatedAt을 함께 보존한다.
    return content
  })
}
