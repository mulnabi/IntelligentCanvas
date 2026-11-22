import { useEffect, useState } from 'react'
import { getArtworkErrorMessage, observeArtwork, observeArtworks } from '../repositories/artworkRepository'

function useArtworkQuery(uid, artworkId, search, sort) {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState(null)
  const key = JSON.stringify([uid, artworkId, search, sort, attempt])

  useEffect(() => {
    if (!uid) return
    let active = true
    let stop
    const observer = {
      next: data => { if (active) setResult({ key, data, error: '' }) },
      error: error => { if (active) setResult({ key, data: null, error: getArtworkErrorMessage(error) }) },
    }
    const subscription = artworkId === null
      ? observeArtworks(uid, { search, sort }, observer)
      : observeArtwork(uid, artworkId, observer)
    subscription.then(unsubscribe => {
      if (active) stop = unsubscribe
      else unsubscribe()
    }).catch(observer.error)
    return () => { active = false; stop?.() }
  }, [uid, artworkId, search, sort, key])

  // UID/검색 조건이 바뀐 렌더부터 이전 결과를 숨기고 늦게 끝난 이전 조회도 노출하지 않는다.
  const current = uid && result?.key === key ? result : null
  return {
    data: current?.data ?? null,
    loading: !!uid && !current,
    error: current?.error ?? '',
    retry: () => setAttempt(value => value + 1),
  }
}

export function useArtworks(uid, search = '', sort = 'updatedAt') {
  const { data, ...state } = useArtworkQuery(uid, null, search, sort)
  return { artworks: data ?? [], ...state }
}

export function useArtwork(uid, artworkId) {
  const { data, ...state } = useArtworkQuery(uid, artworkId, '', '')
  return { artwork: data, ...state }
}
