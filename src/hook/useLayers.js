import { createLayer } from '../repositories/layerRepository'

// 편집 세션이 레이어 목록의 최신 상태를 관리하고, 패널은 조작만 전달한다.
export function useLayers({ layers, activeId, selectLayer, changeLayers }) {
  const toggle = id => changeLayers(layers => ({
    layers: layers.map(layer => layer.layerId === id ? { ...layer, visible: !layer.visible } : layer),
  }))

  const setOpacity = (id, opacity) => changeLayers(layers => {
    const layer = layers.find(layer => layer.layerId === id)
    if (!layer || layer.opacity === opacity || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) return
    return { layers: layers.map(layer => layer.layerId === id ? { ...layer, opacity } : layer) }
  })

  // 선택한 레이어 바로 위에 빈 레이어를 삽입한다.
  const add = () => changeLayers((layers, activeId) => {
    const names = new Set(layers.map(layer => layer.name))
    let number = layers.length + 1
    while (names.has(`레이어 ${number}`)) number++
    const layer = createLayer(`레이어 ${number}`)
    const next = [...layers]
    next.splice(layers.findIndex(item => item.layerId === activeId), 0, layer)
    return { layers: next, activeId: layer.layerId }
  })

  const remove = id => changeLayers((layers, activeId) => {
    const index = layers.findIndex(layer => layer.layerId === id)
    if (index < 0 || layers.length <= 1) return
    const next = layers.filter(layer => layer.layerId !== id)
    return {
      layers: next,
      removedId: id,
      activeId: id === activeId ? next[Math.min(index, next.length - 1)].layerId : activeId,
    }
  })

  const move = (id, to) => changeLayers(layers => {
    const from = layers.findIndex(layer => layer.layerId === id)
    if (from < 0 || from === to || !Number.isInteger(to) || to < 0 || to >= layers.length) return
    const next = [...layers]
    const [layer] = next.splice(from, 1)
    next.splice(to, 0, layer)
    return { layers: next }
  })

  return { layers, activeId, select: selectLayer, toggle, setOpacity, add, remove, move }
}
