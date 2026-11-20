import { useEffect, useRef, useState } from 'react'
import { localDb } from '../db/localDb'
import { bindArtworkAccess, callEditSession, claimArtworkTab, EDIT_SESSION_INVALIDATED, getArtworkKind, getDeviceId,
  isConnectionFailure, readTabGrant, storeTabGrant } from '../services/editSessionService'
import { canResumeVerifiedEpoch, checkDownloadTarget, checkSyncEpoch, getSyncConfirmation, readArtworkSync,
  startSyncEpoch } from '../repositories/artworkSyncRepository'
import { preserveRevokedArtwork, RECOVERY_MESSAGE } from '../repositories/recoveryDraftRepository'
import { downloadServerArtwork, registerServerArtwork, syncArtwork, syncBaseline } from '../services/artworkSyncService'
import { withCanvasSaved } from '../services/pendingCanvasChanges'

const initial = { status: 'checking', busy: true, message: '' }

export function useEditSession(uid, artworkId, snapshotOnly = false) {
  const [view, setView] = useState(initial)
  const actions = useRef(null)
  useEffect(() => {
    const access = bindArtworkAccess(uid, artworkId)
    let disposed = false
    let busy = false
    let status = 'checking'
    let proof = null
    let unlock = null
    let verifiedEditing = false
    let takeover = null
    let revocation = null
    let refreshQueued = false
    let canvasEpoch = 0
    function publish(next, message = '') {
      if (disposed) return
      status = next
      const editing = !snapshotOnly && next === 'editing'
      access.setWritable(!snapshotOnly && (next === 'local' || editing))
      access.setSyncing(editing && !revocation)
      setView({ status, busy, message, takeover: next === 'occupied' ? takeover : null, canvasEpoch,
        proof: editing ? proof : null })
    }
    function dropLock() {
      unlock?.()
      unlock = null
    }
    async function takeLock() {
      if (unlock) return true
      const release = await claimArtworkTab(uid, artworkId)
      if (disposed) { release?.(); return false }
      unlock = release
      return Boolean(unlock)
    }
    async function preserveInvalidated(previous) {
      // 같은 브라우저의 편집 탭이 마지막 획을 아직 저장 중일 수 있다.
      if (snapshotOnly && !await takeLock()) {
        return publish('snapshot', '이 브라우저의 작업 초안은 기존 편집 탭에서 보존합니다.')
      }
      revocation = previous
      access.setSyncing(false)
      // 현재 획과 PNG를 로컬에 확정한 뒤에만 초안을 만들고 업로드 대기열을 격리한다.
      if (verifiedEditing && unlock) access.setWritable(true)
      try {
        await withCanvasSaved(() => {
          publish('revoked', RECOVERY_MESSAGE)
          return preserveRevokedArtwork(uid, artworkId, previous)
        })
        verifiedEditing = false
        storeTabGrant(uid, artworkId, null)
        proof = null
        revocation = null
        dropLock()
      } catch (error) {
        const message = error.code === 'canvas/save-failed'
          ? '편집 권한이 무효화되었습니다. 미저장 획을 보존하려면 이 탭에서 초안 보존을 다시 시도해 주세요.'
          : '초안을 보존하지 못했습니다. 기존 로컬 그림과 대기열을 유지했습니다. 초안 보존을 다시 시도해 주세요.'
        publish('revoked', message)
      } finally {
        if (snapshotOnly) dropLock()
      }
    }
    async function refresh() {
      if (revocation) return preserveInvalidated(revocation)
      const state = await readArtworkSync(uid, artworkId)
      if (disposed) return
      if (state?.failure?.revoked) return publish('revoked', RECOVERY_MESSAGE)
      const stored = snapshotOnly ? null : readTabGrant(uid, artworkId)
      proof = stored && await takeLock() ? stored : null
      if (disposed) return
      if (stored && !proof && navigator.locks) storeTabGrant(uid, artworkId, null)
      let result
      try {
        if (!snapshotOnly && !proof && await getArtworkKind(uid, artworkId) === 'local') return publish('local')
        result = await callEditSession('getEditSessionStatus', artworkId, { details: true, ...(proof ? { proof } : {}) })
      } catch (error) {
        if (disposed) return
        if (proof && error.code === 'functions/not-found') return preserveInvalidated(proof)
        if (!isConnectionFailure(error)) throw error
        if (proof && unlock && (verifiedEditing || await canResumeVerifiedEpoch(state, proof))) {
          verifiedEditing = true
          return publish('editing', '서버에 연결되지 않았습니다. 변경 사항을 이 브라우저에 저장합니다.')
        }
        if (status === 'local') return publish('local')
        throw error
      }
      if (disposed) return
      if (result.status === 'held') {
        if (result.localChangesPending) await startSyncEpoch(uid, artworkId, proof)
        verifiedEditing = result.localChangesPending
        return publish(result.localChangesPending ? 'editing' : 'held')
      }
      if (proof || state?.sessionId && state.localVersion !== state.ackLocalVersion
        && (state.generation < result.generation || state.generation === result.generation && result.status === 'available')) {
        return preserveInvalidated(proof ?? state)
      }
      takeover = result.canRecover ? { sessionRef: result.sessionRef, generation: result.generation } : null
      proof = null
      dropLock()
      publish(snapshotOnly ? 'snapshot' : result.status)
    }
    function run(task, retainStatus = false) {
      if (disposed || busy) return
      busy = true
      publish(status)
      void task().catch(error => {
        if (!proof) dropLock()
        if (error.code === 'functions/already-exists') { publish('occupied'); refreshQueued = true }
        else if (retainStatus) publish(status, error.message || '서버 저장 상태를 확인하지 못했습니다.')
        else publish('unavailable', '편집 권한을 확인하지 못해 읽기 전용입니다. 연결을 확인한 뒤 다시 시도해 주세요.')
      }).finally(() => {
        busy = false
        if (disposed) return
        setView(current => ({ ...current, busy: false }))
        if (refreshQueued) { refreshQueued = false; run(refresh) }
      })
    }
    function requestRefresh() {
      if (status === 'revoked' && !revocation) return
      if (busy) refreshQueued = true
      else run(refresh)
    }
    function finishRelease() {
      storeTabGrant(uid, artworkId, null)
      proof = null
      verifiedEditing = false
      dropLock()
      publish('available')
    }
    actions.current = {
      refresh: requestRefresh,
      recover: selection => run(async () => {
        if (status !== 'occupied' || !takeover || selection !== takeover) return
        const key = [uid, artworkId]
        const baseline = await readArtworkSync(uid, artworkId)
        checkDownloadTarget(await localDb.artworks.get(key), baseline, await localDb.syncQueue.get(key))
        if (!await takeLock()) throw new Error('이 작품의 다른 탭을 닫은 다음 다시 시도해 주세요.')
        try {
          proof = await callEditSession('forceRecoverEditSession', artworkId, { ...selection, confirmed: true, deviceId: getDeviceId() })
        } catch (error) {
          takeover = null
          throw error
        }
        storeTabGrant(uid, artworkId, proof)
        if (disposed) return
        publish('held')
        const latest = await downloadServerArtwork(uid, artworkId)
        if (latest.serverVersion !== baseline?.serverVersion) canvasEpoch++
        publish('held')
      }, true),
      register: () => run(async () => {
        if (status !== 'local') return
        await withCanvasSaved(async () => {
          await registerServerArtwork(uid, artworkId)
          publish('available')
        })
      }, true),
      acquire: () => run(async () => {
        if (status !== 'available') return
        if (!navigator.locks) return publish('unavailable', '이 브라우저에서 탭 잠금을 사용할 수 없어 읽기 전용입니다.')
        if (!await takeLock()) return publish('occupied')
        proof = await callEditSession('acquireEditSession', artworkId, { deviceId: getDeviceId() })
        storeTabGrant(uid, artworkId, proof)
        publish('held')
      }),
      begin: () => run(async () => {
        if (status !== 'held' || !proof) return
        const baseline = await syncBaseline(uid, artworkId)
        checkSyncEpoch(baseline, proof)
        const expected = baseline ? { expectedServerVersion: baseline.serverVersion } : {}
        await callEditSession('beginEditSessionChanges', artworkId, { proof, ...expected })
        await startSyncEpoch(uid, artworkId, proof)
        verifiedEditing = true
        publish('editing')
      }, true),
      release: () => run(async () => {
        if (status !== 'held' || !proof) return
        await callEditSession('releaseEditSession', artworkId, { proof })
        finishRelease()
      }),
      finish: () => run(async () => {
        if (status !== 'editing' || !proof) return
        await withCanvasSaved(async () => {
          await syncArtwork(uid, artworkId, proof)
          const confirmation = await getSyncConfirmation(uid, artworkId, proof)
          await callEditSession('releaseEditSession', artworkId, { proof, confirmation })
          finishRelease()
        })
      }, true),
    }
    const rejected = ({ detail }) => {
      if (detail?.uid !== uid || detail?.artworkId !== artworkId) return
      if (detail.confirmed && proof?.generation === detail.generation) {
        revocation = proof
        access.setSyncing(false)
      }
      requestRefresh()
    }
    window.addEventListener('online', requestRefresh)
    window.addEventListener('focus', requestRefresh)
    window.addEventListener(EDIT_SESSION_INVALIDATED, rejected)
    run(refresh)
    return () => {
      disposed = true
      access.close()
      dropLock()
      window.removeEventListener('online', requestRefresh)
      window.removeEventListener('focus', requestRefresh)
      window.removeEventListener(EDIT_SESSION_INVALIDATED, rejected)
    }
  }, [uid, artworkId, snapshotOnly])

  return {
    ...view, writable: !snapshotOnly && (view.status === 'local' || view.status === 'editing'),
    refresh: () => actions.current?.refresh(),
    recover: selection => actions.current?.recover(selection),
    register: () => actions.current?.register(),
    acquire: () => actions.current?.acquire(),
    begin: () => actions.current?.begin(),
    release: () => actions.current?.release(),
    finish: () => actions.current?.finish(),
  }
}
