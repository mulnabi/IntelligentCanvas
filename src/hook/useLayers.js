import { useState } from 'react'

// 레이어 목록 관리 
export function useLayers(initialLayers) {
  const [layers, setLayers] = useState(initialLayers)
  const [activeId, setActiveId] = useState(initialLayers[0].layerId)

  const select = id => setActiveId(id)

  const toggle = id => {
    setLayers(layers.map(l => l.layerId === id ? { ...l, visible: !l.visible } : l))
  }

  const setOpacity = (id, opacity) => {
    setLayers(layers.map(l => l.layerId === id ? { ...l, opacity } : l))
  }

  // 선택된 레이어 바로 위에 추가
  const add = () => {
    const layer = {
      layerId: 'layer-' + Date.now(),
      name: '레이어 ' + (layers.length + 1),
      sortOrder: 0,
      opacity: 1,
      visible: true,
      isTemporary: false,
      category: null,
    }
    const i = layers.findIndex(l => l.layerId === activeId)
    const next = [...layers]
    next.splice(i, 0, layer)
    setLayers(next)
    setActiveId(layer.layerId)
  }
  const remove = id => {
    if (layers.length <= 1) return
    const i = layers.findIndex(l => l.layerId === id)
    const next = layers.filter(l => l.layerId !== id)
    setLayers(next)
    if (id === activeId) setActiveId(next[Math.min(i, next.length - 1)].layerId)
  }

  // id 레이어를 to번째 자리로 이동
  const move = (id, to) => {
    const from = layers.findIndex(l => l.layerId === id)
    if (from === to) return
    const next = [...layers]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    setLayers(next)
  }

  return { layers, activeId, select, toggle, setOpacity, add, remove, move }
}
