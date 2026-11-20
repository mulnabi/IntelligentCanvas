import Dexie, { liveQuery } from 'dexie'
import { localDb } from '../db/localDb'

export const DEFAULT_ARTWORK = Object.freeze({ title: '제목 없음', width: 800, height: 800, backgroundColor: '#ffffff' })
// 현재 UI/계획서에는 상한이 없어 메타데이터 입력에만 적용하는 초기 한도다.
// 실제 Canvas의 지원 크기는 별개다. 렌더러의 총 픽셀 한도는 canvasImage에서 검사한다.
export const MAX_ARTWORK_DIMENSION = 8192
export const MAX_ARTWORK_TITLE_LENGTH = 200

function artworkError(code, message) {
  return Object.assign(new Error(message), { code })
}

export function getArtworkErrorMessage(error) {
  if (error?.code?.startsWith('artwork/')) return error.message
  if (error?.message?.startsWith('[Firebase 설정]')) return error.message
  if (error?.name === 'QuotaExceededError' || error?.inner?.name === 'QuotaExceededError') {
    return '브라우저 저장 공간이 부족합니다. 저장 공간을 확보한 후 다시 시도해 주세요.'
  }
  if (['DatabaseClosedError', 'VersionError', 'UpgradeError'].includes(error?.name)) {
    return '로컬 DB를 열지 못했습니다. 다른 탭을 닫고 새로고침해 주세요. 저장 데이터는 초기화하지 않습니다.'
  }
  return '이 브라우저의 작품 저장소에 접근하지 못했습니다. 저장소 사용 설정을 확인하고 다시 시도해 주세요.'
}

export function normalizeArtworkTitle(value, allowDefault = false) {
  const title = typeof value === 'string' ? value.trim() : ''
  if (!title && allowDefault) return DEFAULT_ARTWORK.title
  if (!title || title.length > MAX_ARTWORK_TITLE_LENGTH) {
    throw artworkError('artwork/invalid-title', `작품 제목은 1~${MAX_ARTWORK_TITLE_LENGTH}자로 입력해 주세요.`)
  }
  return title
}

function normalizeSearch(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase()
}

function dimension(value) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_ARTWORK_DIMENSION) {
    throw artworkError('artwork/invalid-size', `가로와 세로는 1~${MAX_ARTWORK_DIMENSION} 사이의 정수로 입력해 주세요.`)
  }
  return number
}

// uid 인자를 신뢰하지 않고 기존 Firebase 기본 앱의 현재 사용자와 대조한다.
// IndexedDB는 사용자가 직접 접근할 수 있는 로컬 저장소이며 서버 보안 경계가 아니다.
export function assertUser(auth, uid) {
  if (!uid || !auth.currentUser) throw artworkError('artwork/auth-required', '로그인한 후 작품을 이용해 주세요.')
  if (auth.currentUser.uid !== uid) throw artworkError('artwork/auth-changed', '로그인 계정이 변경되었습니다. 현재 계정의 작품 목록에서 다시 시도해 주세요.')
}

export async function scopedAuth(uid) {
  const { auth } = await import('../config/firebase.js')
  await auth.authStateReady()
  assertUser(auth, uid)
  return auth
}

export async function readArtwork(auth, uid, artworkId) {
  assertUser(auth, uid)
  const artwork = typeof artworkId === 'string' && artworkId
    ? await localDb.artworks.get([uid, artworkId]) : null
  assertUser(auth, uid)
  if (!artwork || artwork.uid !== uid || artwork.state !== 'active') {
    // 다른 UID의 존재 여부도 구분해서 노출하지 않는다.
    throw artworkError('artwork/not-found', '작품이 없거나 현재 계정으로 열 수 없습니다.')
  }
  return artwork
}

async function queryArtworks(auth, uid, { search = '', sort = 'updatedAt' } = {}) {
  assertUser(auth, uid)
  const field = sort === 'createdAt' ? 'createdAt' : 'updatedAt'
  const records = await localDb.artworks.where(`[uid+state+${field}]`)
    .between([uid, 'active', Dexie.minKey], [uid, 'active', Dexie.maxKey]).reverse().toArray()
  assertUser(auth, uid)
  const query = normalizeSearch(search)
  const result = records.filter(artwork => artwork.titleNormalized.includes(query))
  // 같은 시각에도 순서가 안정적이도록 ID로 보조 정렬한다.
  return result.sort((a, b) => (sort === 'title'
    ? a.title.localeCompare(b.title, 'ko') : b[field] - a[field]) || a.artworkId.localeCompare(b.artworkId))
}

export async function listArtworks(uid, options) {
  return queryArtworks(await scopedAuth(uid), uid, options)
}

export async function getArtwork(uid, artworkId) {
  return readArtwork(await scopedAuth(uid), uid, artworkId)
}

async function observableQuery(query) {
  try {
    return await query()
  } catch (error) {
    // Dexie liveQuery는 이 두 오류를 내부 재시도로 간주해 구독자에게 전달하지 않는다.
    // 앱에서는 무한 로딩 대신 저장소 오류와 재시도 안내를 보여준다.
    if (['DatabaseClosedError', 'AbortError'].includes(error?.name)) {
      throw artworkError('artwork/query-unavailable', getArtworkErrorMessage(error))
    }
    throw error
  }
}

// 인증 복구 같은 외부 비동기 처리는 구독 전에 완료한다.
// querier 내부는 Dexie 조회만 사용해 생성·수정·삭제 및 다른 탭 변경을 관찰한다.
export async function observeArtworks(uid, options, observer) {
  const auth = await scopedAuth(uid)
  const subscription = liveQuery(() => observableQuery(() => queryArtworks(auth, uid, options))).subscribe(observer)
  return () => subscription.unsubscribe()
}

export async function observeArtwork(uid, artworkId, observer) {
  const auth = await scopedAuth(uid)
  const subscription = liveQuery(() => observableQuery(() => readArtwork(auth, uid, artworkId))).subscribe(observer)
  return () => subscription.unsubscribe()
}

export async function createArtwork(uid, input = {}) {
  const auth = await scopedAuth(uid)
  const title = normalizeArtworkTitle(input.title, true)
  const width = dimension(input.width ?? DEFAULT_ARTWORK.width)
  const height = dimension(input.height ?? DEFAULT_ARTWORK.height)
  const backgroundColor = input.backgroundColor ?? DEFAULT_ARTWORK.backgroundColor
  if (typeof backgroundColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(backgroundColor)) {
    throw artworkError('artwork/invalid-background', '배경색은 #ffffff 형식의 색상이어야 합니다.')
  }
  if (!globalThis.crypto?.randomUUID) throw artworkError('artwork/unsupported', '안전한 작품 ID를 만들 수 없습니다. localhost 또는 HTTPS 주소를 사용해 주세요.')
  const now = Date.now() // 로컬 시각(ms). Firestore Timestamp 또는 서버 확정 시각이 아님.
  const artwork = {
    artworkId: crypto.randomUUID(), uid, title, titleNormalized: normalizeSearch(title),
    width, height, backgroundColor: backgroundColor.toLowerCase(),
    createdAt: now, updatedAt: now, schemaVersion: 1, state: 'active', deletedAt: null,
  }
  await localDb.transaction('rw', localDb.artworks, async () => {
    assertUser(auth, uid)
    await localDb.artworks.add(artwork)
    assertUser(auth, uid) // 계정이 바뀌었다면 트랜잭션을 취소한다.
  })
  return artwork
}

export async function renameArtwork(uid, artworkId, value) {
  const auth = await scopedAuth(uid)
  const title = normalizeArtworkTitle(value)
  return localDb.transaction('rw', localDb.artworks, async () => {
    const artwork = await readArtwork(auth, uid, artworkId)
    if (artwork.title === title) return artwork
    const changes = { title, titleNormalized: normalizeSearch(title), updatedAt: Date.now() }
    await localDb.artworks.update([uid, artworkId], changes)
    assertUser(auth, uid)
    return { ...artwork, ...changes }
  })
}

export async function deleteArtwork(uid, artworkId) {
  const auth = await scopedAuth(uid)
  return localDb.transaction('rw', localDb.artworks, async () => {
    await readArtwork(auth, uid, artworkId)
    const now = Date.now()
    // 계획서의 삭제 표식. 서버 동기화/휴지통 복원은 아직 구현하지 않는다.
    await localDb.artworks.update([uid, artworkId], { state: 'deleted', deletedAt: now, updatedAt: now })
    assertUser(auth, uid)
  })
}
