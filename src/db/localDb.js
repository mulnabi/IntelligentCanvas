import Dexie from 'dexie'

export const LOCAL_DB_NAME = 'IntelligentCanvasLocal'
export const LOCAL_DB_VERSION = 3

// HMR에서도 이전 스키마 연결만 교체하고 같은 DB와 기존 레코드를 보존한다.
const cachedDb = import.meta.hot?.data.localDb
const reusable = cachedDb?.verno === LOCAL_DB_VERSION
if (cachedDb && !reusable) cachedDb.close()
export const localDb = reusable ? cachedDb : new Dexie(LOCAL_DB_NAME)
if (!reusable) {
  // v1 계약을 그대로 유지한다. 콘텐츠 없는 기존 작품은 빈 Canvas로 열린다.
  localDb.version(1).stores({
    artworks: '[uid+artworkId], [uid+state+updatedAt], [uid+state+createdAt]',
  })
  // 새 테이블만 추가하므로 레코드 변환/초기화용 upgrade()는 필요하지 않다.
  // PNG Blob과 시각은 조회 색인으로 사용하지 않는다.
  localDb.version(2).stores({
    canvasContents: '[uid+artworkId]',
  })
  // 원본 PNG 이전은 인증된 작품을 열 때만 처리한다.
  localDb.version(3).stores({
    layers: '[uid+artworkId+layerId], [uid+artworkId+sortOrder]',
    layerContents: '[uid+artworkId+layerId]',
  })
}
if (import.meta.hot) import.meta.hot.data.localDb = localDb
