// 임시 데이터 (서버 연결 전까지)

export const artworks = [
  {
    id: 1,
    title: '오리지널 캐릭터 시안',
    thumbnail: 'https://picsum.photos/seed/oc01/400/300',
    layerCount: 7,
    updatedAt: '2026-09-27',
  },
  {
    id: 2,
    title: 'SD 연습 3',
    thumbnail: 'https://picsum.photos/seed/sd03/400/300',
    layerCount: 4,
    updatedAt: '2026-09-26',
  },
  {
    id: 3,
    title: '배경 러프',
    thumbnail: '',
    layerCount: 2,
    updatedAt: '2026-09-24',
  },
  {
    id: 4,
    title: '손 크로키 모음',
    thumbnail: 'https://picsum.photos/seed/hand7/400/300',
    layerCount: 12,
    updatedAt: '2026-09-19',
  },
  {
    id: 5,
    title: '제목 없음',
    thumbnail: '',
    layerCount: 1,
    updatedAt: '2026-08-19',
  },
]
export const dummyLayers = [
  { layerId: 'layer-3', name: '얼굴 선', sortOrder: 1, opacity: 1, visible: true, isTemporary: false, category: '선화' },
  { layerId: 'layer-2', name: '머리카락', sortOrder: 2, opacity: 0.8, visible: true, isTemporary: false, category: '채색' },
  { layerId: 'layer-1', name: '하늘', sortOrder: 3, opacity: 1, visible: true, isTemporary: false, category: '배경' },
]
