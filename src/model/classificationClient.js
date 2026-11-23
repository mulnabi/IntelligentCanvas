let worker
let nextId = 0
const requests = new Map()

function getWorker() {
  if (worker) return worker
  const instance = new Worker(new URL('./classificationWorker.js', import.meta.url), { type: 'module' })
  instance.onmessage = ({ data: { id, result, error } }) => {
    const request = requests.get(id)
    if (!request) return
    requests.delete(id)
    if (error !== undefined) request.reject(new Error(error))
    else request.resolve(result)
  }
  instance.onerror = event => {
    const error = new Error(event.message || 'AI 분류 워커를 시작하지 못했습니다.')
    for (const request of requests.values()) request.reject(error)
    requests.clear()
    instance.terminate()
    worker = undefined
  }
  worker = instance
  return worker
}

export function classifyImage(canvas, kind) {
  const instance = getWorker()
  const bitmap = canvas.transferToImageBitmap()
  const id = ++nextId
  return new Promise((resolve, reject) => {
    requests.set(id, { resolve, reject })
    try {
      instance.postMessage({ id, kind, bitmap }, [bitmap])
    } catch (error) {
      requests.delete(id)
      bitmap.close()
      reject(error)
    }
  })
}
