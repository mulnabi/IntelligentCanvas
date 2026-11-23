import { useCallback, useEffect, useRef, useState } from 'react'
import { useBlocker } from 'react-router'
import { getCanvasErrorMessage } from '../repositories/canvasRepository'
import { EMPTY_LAYER_CATEGORY, openLayerDocument, saveLayerChanges } from '../repositories/layerRepository'
import { canvasImageError, extractCanvasPng, hasVisiblePixels, prepareCanvas } from '../services/canvasImage'
import { createLayerCanvas } from '../services/layerCanvas'
import { registerPendingCanvasEditor } from '../services/pendingCanvasChanges'
import { canWriteOpenArtwork } from '../services/editSessionService'

const loadingState = { status: 'loading', ready: false, locked: false, error: '', failure: null, layers: [], activeId: null }

export function useCanvasPersistence({ uid, artworkId, width, height }, canvasApi, serverSnapshot) {
  const sessionRef = useRef(null)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState(loadingState)
  const blocker = useBlocker(useCallback(({ currentLocation, nextLocation }) =>
    (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search)
      && !!sessionRef.current?.dirty(), []))
  const blockedTask = useRef(null)
  const getLayerPreview = useCallback(layerId => sessionRef.current?.preview(layerId), [])

  useEffect(() => {
    const abort = new AbortController()
    const session = {
      disposed: false, ready: false, activeStroke: false, locks: 0, timer: null, busy: null,
      error: '', failure: null, hadContent: false, layers: [], activeId: null, previousIds: [],
      revision: 0, metadataRevision: 0, dirtyPixels: new Map(), initialContents: null,
    }
    let renderer
    const unsaved = () => session.metadataRevision > 0 || session.dirtyPixels.size > 0
    const dirty = () => session.activeStroke || unsaved() || !!session.busy
    const emit = () => {
      if (session.disposed) return
      const status = session.error ? 'error' : !session.ready ? 'loading' : session.busy ? 'saving'
        : session.activeStroke || unsaved() ? 'pending' : session.hadContent ? 'saved' : 'ready'
      setState({
        status, ready: session.ready, locked: session.locks > 0, error: session.error, failure: session.failure,
        layers: session.layers, activeId: session.activeId,
      })
    }
    const fail = (error, failure) => {
      session.error = getCanvasErrorMessage(error)
      session.failure = failure
      emit()
    }
    const pump = () => {
      clearTimeout(session.timer)
      if (serverSnapshot) return Promise.resolve()
      if (session.busy) return session.busy
      if (!session.ready || session.disposed || session.activeStroke || !unsaved()) return Promise.resolve()
      session.error = ''
      session.failure = null
      // 하나의 worker에서 PNG 추출과 DB 커밋을 순서대로 완료한다.
      const work = async () => {
        try {
          while (session.ready && !session.disposed && !session.activeStroke && unsaved()) {
            const metadataRevision = session.metadataRevision
            const layers = metadataRevision || session.initialContents ? session.layers : undefined
            const pixels = [...session.dirtyPixels]
            const initialContents = session.initialContents?.filter(content =>
              layers.some(layer => layer.layerId === content.layerId) && !session.dirtyPixels.has(content.layerId)) ?? []
            // 각 toBlob이 호출 시점의 픽셀을 캡처한다. 이후 새 획은 다음 저장에 속한다.
            const contents = await Promise.all(pixels.map(async ([layerId]) => {
              const original = renderer.getOriginal(layerId, false)
              prepareCanvas(original, width, height)
              return { layerId, pngBlob: await extractCanvasPng(original), width, height }
            }))
            if (session.disposed || !session.ready) return
            await saveLayerChanges(uid, artworkId, { previousIds: session.previousIds, layers, contents: [...contents, ...initialContents] })
            session.initialContents = null
            if (layers) session.previousIds = layers.map(layer => layer.layerId)
            if (session.metadataRevision === metadataRevision) session.metadataRevision = 0
            for (const [layerId, revision] of pixels) {
              if (session.dirtyPixels.get(layerId) === revision) session.dirtyPixels.delete(layerId)
            }
            session.hadContent = true
          }
        } catch (error) {
          fail(error, 'save')
          throw Object.assign(new Error(getCanvasErrorMessage(error)), { code: 'canvas/save-failed' })
        } finally {
          session.busy = null
          emit()
        }
      }
      // work의 동기 throw/finally보다 busy 대입이 먼저 이루어지도록 한다.
      session.busy = Promise.resolve().then(work)
      emit()
      return session.busy
    }
    const flush = async () => {
      canvasApi.current?.finishStroke()
      clearTimeout(session.timer)
      await pump()
      if (unsaved()) throw Object.assign(new Error(session.error || '그림 저장을 완료하지 못했습니다. 다시 저장해 주세요.'), { code: 'canvas/save-failed' })
    }
    const lock = () => {
      session.locks++
      canvasApi.current?.finishStroke()
      emit()
      return () => { session.locks = Math.max(0, session.locks - 1); emit() }
    }
    const canView = () => session.ready && !session.locks && !session.disposed
    const canEdit = () => !serverSnapshot && canView() && canWriteOpenArtwork(uid, artworkId)
    const schedule = () => {
      emit()
      if (!session.ready || session.disposed || !unsaved()) return
      clearTimeout(session.timer)
      session.timer = setTimeout(() => { void pump().catch(() => {}) }, 250)
    }
    const renderError = error => {
      session.ready = false
      fail(error, 'render')
    }
    const compose = preview => {
      try {
        renderer.compose(session.layers, preview)
      } catch (error) {
        canvasApi.current?.finishStroke()
        renderError(error)
      }
    }
    sessionRef.current = {
      dirty, flush, lock,
      canEdit,
      original: (layerId, allocate) => canEdit() ? renderer.getOriginal(layerId, allocate) : undefined,
      preview: layerId => session.ready && !session.disposed ? renderer.getOriginal(layerId, false) : undefined,
      compose,
      start: () => { if (canEdit()) { clearTimeout(session.timer); session.activeStroke = true; emit() } },
      end: (layerId, changed) => {
        session.activeStroke = false
        if (changed) {
          const pixelRevision = ++session.revision
          session.dirtyPixels.set(layerId, pixelRevision)
          session.layers = session.layers.map(layer => layer.layerId === layerId ? { ...layer, pixelRevision } : layer)
        }
        schedule()
      },
      renderError,
      select: layerId => {
        if (!canView() || !session.layers.some(layer => layer.layerId === layerId)) return
        session.activeId = layerId
        emit()
      },
      changeLayers: update => {
        if (!canEdit()) return
        const change = update(session.layers, session.activeId)
        if (!change) return
        if (change.removedId) {
          // 지울 레이어가 현재 획의 입력 대상일 수도 있다.
          canvasApi.current?.finishStroke()
          session.dirtyPixels.delete(change.removedId)
          renderer.remove(change.removedId)
        }
        const changedIds = new Set(change.changedPixelIds)
        session.layers = change.layers.map((layer, sortOrder) => {
          if (!changedIds.has(layer.layerId)) return { ...layer, sortOrder }
          const pixelRevision = ++session.revision
          session.dirtyPixels.set(layer.layerId, pixelRevision)
          return { ...layer, sortOrder, pixelRevision }
        })
        session.activeId = change.activeId ?? session.activeId
        session.metadataRevision = ++session.revision
        compose()
        schedule()
      },
    }
    const unregister = serverSnapshot ? null : registerPendingCanvasEditor(sessionRef.current)
    const onBeforeUnload = event => {
      if (!dirty()) return
      void flush().catch(() => {})
      event.preventDefault()
      event.returnValue = ''
    }
    const onVisibility = () => { if (document.visibilityState === 'hidden' && dirty()) void flush().catch(() => {}) }
    window.addEventListener('beforeunload', onBeforeUnload)
    document.addEventListener('visibilitychange', onVisibility)
    void (async () => {
      try {
        renderer = createLayerCanvas(canvasApi.current?.getCanvas(), width, height, () => {
          canvasApi.current?.finishStroke()
          renderError(canvasImageError('레이어 픽셀을 읽을 수 없습니다. 마지막 저장본을 다시 불러와 주세요.'))
        })
        const { layers, contents, unpersisted } = serverSnapshot ?? await openLayerDocument(uid, artworkId, {
          prepare: document => renderer.restore(document, abort.signal), signal: abort.signal,
        })
        if (serverSnapshot) await renderer.restore(serverSnapshot, abort.signal)
        if (session.disposed) return
        session.layers = layers.map(layer => {
          const source = renderer.getOriginal(layer.layerId, false)
          if (!source) return { ...layer, category: EMPTY_LAYER_CATEGORY }
          const ctx = source.getContext('2d')
          for (let y = 0; y < source.height; y += 128) {
            if (hasVisiblePixels(ctx.getImageData(0, y, source.width, Math.min(128, source.height - y)))) {
              return layer.category === EMPTY_LAYER_CATEGORY ? { ...layer, category: null } : layer
            }
          }
          return { ...layer, category: EMPTY_LAYER_CATEGORY }
        })
        session.activeId = layers[0].layerId
        session.previousIds = unpersisted ? [] : layers.map(layer => layer.layerId)
        session.initialContents = unpersisted ? contents : null
        session.ready = true
        session.hadContent = !!contents.length
        emit()
      } catch (error) {
        renderer?.release()
        if (!session.disposed) fail(error, 'load')
      }
    })()
    return () => {
      session.disposed = true
      clearTimeout(session.timer)
      abort.abort()
      renderer?.release()
      unregister?.()
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('visibilitychange', onVisibility)
      sessionRef.current = null
    }
    // artwork.updatedAt 변경은 복원을 다시 실행하지 않는다.
  }, [uid, artworkId, width, height, attempt, canvasApi, serverSnapshot])

  useEffect(() => {
    if (blocker.state !== 'blocked') { blockedTask.current = null; return }
    const session = sessionRef.current
    if (!session || blockedTask.current === blocker.location.key) return
    blockedTask.current = blocker.location.key
    const unlock = session.lock()
    let active = true
    void session.flush().then(() => { if (active) blocker.proceed() }).catch(() => {}).finally(unlock)
    return () => { active = false }
  }, [blocker])

  const retrySave = async () => {
    const session = sessionRef.current
    if (!session) return
    const unlock = blocker.state === 'blocked' ? session.lock() : () => {}
    try {
      await session.flush()
      if (blocker.state === 'blocked') blocker.proceed()
    } catch { /* 현재 Canvas와 오류 표시를 유지한다. */ }
    finally { unlock() }
  }
  return {
    ...state,
    canDraw: () => sessionRef.current?.canEdit() === true,
    blocked: blocker.state === 'blocked',
    onStrokeStart: () => sessionRef.current?.start(),
    onStrokeEnd: (layerId, changed) => sessionRef.current?.end(layerId, changed),
    onRenderError: error => sessionRef.current?.renderError(error),
    getLayerCanvas: (layerId, allocate) => sessionRef.current?.original(layerId, allocate),
    compose: preview => sessionRef.current?.compose(preview),
    getLayerPreview,
    selectLayer: layerId => sessionRef.current?.select(layerId),
    changeLayers: update => sessionRef.current?.changeLayers(update),
    retrySave,
    retryLoad: () => {
      if (state.failure === 'render' && !window.confirm('마지막 저장본을 다시 불러오면 저장되지 않은 변경은 사라질 수 있습니다. 계속하시겠습니까?')) return
      setState(loadingState)
      setAttempt(value => value + 1)
    },
    stay: () => { if (blocker.state === 'blocked') blocker.reset() },
  }
}
