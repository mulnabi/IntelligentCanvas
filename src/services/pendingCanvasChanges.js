let editor = null

// Auth 작업이 UID를 바꾸기 전에 현재 편집 화면의 미저장 내용을 확정한다.
export function registerPendingCanvasEditor(value) {
  editor = value
  return () => { if (editor === value) editor = null }
}

export async function withCanvasSaved(action) {
  const current = editor
  const unlock = current?.lock()
  try {
    await current?.flush()
    return await action()
  } finally { unlock?.() }
}
