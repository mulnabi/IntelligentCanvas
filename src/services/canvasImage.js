// RGBA 버퍼만 64 MiB인 크기를 초기 편집 상한으로 삼는다. PNG/디코딩 사본도
// 메모리를 쓰므로 8192×8192 메타데이터를 무조건 Canvas로 할당하지 않는다.
export const MAX_EDITABLE_CANVAS_PIXELS = 16_777_216

export function canvasImageError(message) {
  return Object.assign(new Error(message), { code: 'canvas/image-error' })
}

export function canAllocateCanvas(width, height) {
  return [width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 8192)
    && width * height <= MAX_EDITABLE_CANVAS_PIXELS
}

export function prepareCanvas(canvas, width, height) {
  if (!canAllocateCanvas(width, height)) {
    throw canvasImageError('이 작품은 현재 편집 한도(총 16,777,216픽셀)를 넘습니다. 작품 정보와 저장된 그림은 유지됩니다. 더 작은 크기의 작품을 사용해 주세요.')
  }
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    throw canvasImageError('그림판 크기를 준비하지 못했습니다. 다시 불러와 주세요.')
  }
  try {
    const context = canvas.getContext('2d')
    if (!context || context.isContextLost?.()) throw new Error('Canvas unavailable')
    context.getImageData(0, 0, 1, 1) // 작은 읽기로 사용 가능한 버퍼인지 확인한다.
    return context
  } catch {
    throw canvasImageError('그림판 메모리를 확보하지 못했습니다. 다른 탭을 닫고 다시 불러와 주세요.')
  }
}

export function extractCanvasPng(canvas) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(canvasImageError('PNG 변환 시간이 초과되었습니다. 화면을 유지한 채 다시 저장해 주세요.')), 30000)
    try {
      // 호출 시점의 비트맵을 스냅샷으로 인코딩한다. CSS 배율은 포함하지 않는다.
      canvas.toBlob(blob => {
        clearTimeout(timer)
        if (blob?.size && blob.type === 'image/png') resolve(blob)
        else reject(canvasImageError('PNG 그림을 만들지 못했습니다. 메모리 여유를 확보하고 다시 저장해 주세요.'))
      }, 'image/png')
    } catch {
      clearTimeout(timer)
      reject(canvasImageError('PNG 추출에 실패했습니다. 현재 그림을 유지한 채 다시 저장해 주세요.'))
    }
  })
}

export async function restoreCanvasPng(canvas, content, width, height, signal) {
  const context = prepareCanvas(canvas, width, height)
  if (!content) {
    if (!signal.aborted) context.clearRect(0, 0, width, height)
    return
  }
  const url = URL.createObjectURL(content.pngBlob)
  try {
    const image = await new Promise((resolve, reject) => {
      const image = new Image()
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); image.onload = null; image.onerror = null }
      const fail = error => { cleanup(); image.src = ''; reject(error) }
      const abort = () => fail(new DOMException('Aborted', 'AbortError'))
      const timer = setTimeout(() => fail(canvasImageError('저장된 그림을 여는 시간이 초과되었습니다. 다시 불러와 주세요.')), 30000)
      image.onload = () => { cleanup(); resolve(image) }
      image.onerror = () => fail(canvasImageError('저장된 PNG를 복원하지 못했습니다. 기존 파일은 유지되며 빈 그림으로 덮어쓰지 않습니다.'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else image.src = url
    })
    if (signal.aborted) return
    if (image.naturalWidth !== width || image.naturalHeight !== height) {
      throw canvasImageError('PNG 해상도와 작품 크기가 다릅니다. 기존 그림을 늘이거나 자르지 않고 복원을 중단했습니다.')
    }
    context.save()
    try {
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.globalCompositeOperation = 'source-over'
      context.globalAlpha = 1
      context.clearRect(0, 0, width, height)
      context.drawImage(image, 0, 0) // 크기 변경 없이 원본 픽셀 그대로 복원한다.
    } finally { context.restore() }
  } catch (error) {
    if (error?.code?.startsWith('canvas/') || error?.name === 'AbortError') throw error
    throw canvasImageError('PNG 복원 중 메모리 또는 픽셀 처리 오류가 발생했습니다. 기존 저장본은 유지됩니다. 다른 탭을 닫고 다시 불러와 주세요.')
  } finally { URL.revokeObjectURL(url) }
}
