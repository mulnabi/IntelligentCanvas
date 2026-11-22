import { useEffect, useRef, useState } from 'react'

const categories = ['명암', '선화', '채색']
// Serialize requests across editor mounts so two copies of the model never run together.
let inference = Promise.resolve()

export function useLayerClassification(watchLayerRevision, categorize) {
  const [enabled, setEnabled] = useState(false)
  const [status, setStatus] = useState('')
  const latestRequest = useRef(0)

  useEffect(() => () => { latestRequest.current++ }, [])

  const enable = checked => {
    latestRequest.current++
    setStatus('')
    setEnabled(checked)
  }
  const classify = (layerId, canvas) => {
    if (!enabled) return
    const revisionIsCurrent = watchLayerRevision(layerId)
    if (!revisionIsCurrent) return
    const request = ++latestRequest.current
    const isLatest = () => request === latestRequest.current
    const isCurrent = () => isLatest() && revisionIsCurrent()
    setStatus('AI 레이어 분류 중…')
    inference = inference.then(async () => {
      let nextStatus = ''
      try {
        if (!isCurrent()) return
        const { predict } = await import('../model/model')
        if (!isCurrent()) return
        const category = categories[await predict(canvas, isCurrent)]
        if (category && isCurrent()) categorize(layerId, category)
      } catch {
        if (isCurrent()) nextStatus = 'AI 모델을 불러오거나 실행하지 못했습니다. 그림은 그대로 유지됩니다.'
      } finally {
        if (isLatest()) setStatus(nextStatus)
      }
    })
  }
  return { enabled, status, enable, classify }
}
