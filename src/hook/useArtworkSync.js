import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { localDb } from '../db/localDb'
import { readArtworkSync } from '../repositories/artworkSyncRepository'
import { syncArtwork } from '../services/artworkSyncService'

export function useArtworkSync(uid, artworkId, proof) {
  const [uploading, setUploading] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [online, setOnline] = useState(() => navigator.onLine)
  const state = useLiveQuery(() => readArtworkSync(uid, artworkId), [uid, artworkId])
  const pending = state && state.localVersion !== state.ackLocalVersion
  const terminal = state?.failure?.terminal === true
  const failures = state?.failure?.attempts ?? 0
  const revision = state?.localVersion
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    const resume = () => {
      update()
      if (!proof) return
      void localDb.transaction('rw', localDb.artworkSync, async () => {
        const current = await readArtworkSync(uid, artworkId)
        if (current?.failure?.connection && !current.failure.terminal) {
          await localDb.artworkSync.update([uid, artworkId], { failure: null })
        }
      }).catch(() => {})
    }
    window.addEventListener('offline', update)
    window.addEventListener('online', resume)
    window.addEventListener('focus', resume)
    return () => {
      window.removeEventListener('offline', update)
      window.removeEventListener('online', resume)
      window.removeEventListener('focus', resume)
    }
  }, [uid, artworkId, proof])
  useEffect(() => {
    if (!proof || !online || !pending || terminal || failures >= 3) return
    let active = true
    // 프레임 밖에서 상태 변경과 서버 작업을 시작한다.
    const timer = setTimeout(() => {
      setUploading(true)
      void syncArtwork(uid, artworkId, proof).catch(() => {}).finally(() => { if (active) setUploading(false) })
    }, failures ? failures * 1500 : 0)
    return () => { active = false; clearTimeout(timer) }
  }, [uid, artworkId, proof, online, pending, terminal, failures, revision, attempt])
  return { state, pending, uploading: uploading && online && pending && !state?.failure, online, terminal,
    retry: async () => {
      if (terminal) return
      await localDb.artworkSync.update([uid, artworkId], { failure: null })
      setAttempt(value => value + 1)
    } }
}
