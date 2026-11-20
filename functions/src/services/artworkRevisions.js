const labels = {
  layer_created: '추가', layer_deleted: '삭제', layer_renamed: '이름 변경', layer_reordered: '순서 변경',
  layer_visibility_changed: '표시 변경', layer_opacity_changed: '불투명도 변경', layer_pixels_modified: '그림 수정',
  layer_settings_changed: '설정 변경',
}
const fields = {
  name: 'layer_renamed', visible: 'layer_visibility_changed', opacity: 'layer_opacity_changed',
  isTemporary: 'layer_settings_changed', category: 'layer_settings_changed',
}

function buildRevision(before, meta, manifest, result, createdAt) {
  const oldLayers = before.layerManifest ?? []
  const previous = new Map(oldLayers.map(layer => [layer.layerId, layer]))
  const current = new Map(manifest.map(layer => [layer.layerId, layer]))
  const oldShared = oldLayers.filter(layer => current.has(layer.layerId))
  const newShared = manifest.filter(layer => previous.has(layer.layerId))
  const reordered = new Set(newShared.filter((layer, index) => layer.layerId !== oldShared[index].layerId)
    .map(({ layerId }) => layerId))
  const changedLayers = []
  for (const layer of [...manifest, ...oldLayers.filter(layer => !current.has(layer.layerId))]) {
    const { layerId, name } = layer
    const old = previous.get(layerId)
    const operations = new Set()
    if (!old) operations.add('layer_created')
    else if (!current.has(layerId)) operations.add('layer_deleted')
    else {
      for (const [field, type] of Object.entries(fields)) if (layer[field] !== old[field]) operations.add(type)
      if (reordered.has(layerId)) operations.add('layer_reordered')
      if (layer.currentRevisionId !== old.currentRevisionId) operations.add('layer_pixels_modified')
    }
    if (operations.size) {
      const operationTypes = [...operations]
      changedLayers.push({ layerId, name, operationTypes, description: operationTypes.map(type => labels[type]).join(' · ') })
    }
  }
  const metadataChanged = Object.keys(meta).some(key => before[key] !== meta[key])
  const operationTypes = new Set(changedLayers.flatMap(layer => layer.operationTypes))
  if (metadataChanged) operationTypes.add('artwork_metadata_changed')
  if (!operationTypes.size) return null
  const summaries = changedLayers.slice(0, 3).map(layer => `${layer.name} 레이어 ${layer.description}`)
  if (changedLayers.length > 3) summaries.push(`외 ${changedLayers.length - 3}개 레이어`)
  if (metadataChanged) summaries.push('작품 정보 변경')
  return { revisionId: result.requestId, requestId: result.requestId, serverVersion: result.serverVersion,
    createdAt, changedLayers, operationTypes: [...operationTypes], summary: summaries.join(', ') }
}

module.exports = { buildRevision }
