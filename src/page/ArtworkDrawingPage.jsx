import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useArtwork } from '../hook/useArtworks'
import { loadServerArtworkSnapshot } from '../services/artworkSyncService'
import DrawingSpace from './DrawingSpace'

function WorkingArtwork({ uid, artworkId }) {
  const { artwork, loading, error, retry } = useArtwork(uid, artworkId)
  if (loading) return <p className="no-result" role="status">작품을 불러오는 중…</p>
  if (error || !artwork) return <p className="no-result" role="alert">
    {error || '작품을 열 수 없습니다.'} <button onClick={retry}>다시 시도</button> <Link to="/">작품 목록</Link>
  </p>
  return <DrawingSpace key={`${uid}:${artwork.artworkId}:${artwork.width}:${artwork.height}`} artwork={artwork}/>
}

function ConfirmedArtwork({ uid, artworkId }) {
  const [result, setResult] = useState(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    void loadServerArtworkSnapshot(uid, artworkId, abort.signal).then(snapshot => {
      if (!abort.signal.aborted) setResult({ snapshot })
    }).catch(error => {
      if (!abort.signal.aborted) setResult({
        error: error.code === 'functions/failed-precondition' ? '다운로드 중 서버 버전이 변경됐습니다. 다시 열어 주세요.'
          : '서버 확정본을 불러오지 못했습니다. 연결과 작품 접근 권한을 확인해 주세요.',
      })
    })
    return () => abort.abort()
  }, [uid, artworkId, attempt])
  if (!result) return <p className="no-result" role="status">서버 확정본을 불러오는 중…</p>
  if (result.error) return <p className="no-result" role="alert">
    {result.error}{' '}
    <button onClick={() => { setResult(null); setAttempt(value => value + 1) }}>다시 시도</button>{' '}
    <Link to="/">작품 목록</Link>
  </p>
  const { snapshot } = result
  return <DrawingSpace key={snapshot.serverVersion} artwork={snapshot.artwork} serverSnapshot={snapshot} />
}

export default function ArtworkDrawingPage({ uid, authLoading = false, authError = '' }) {
  const { artworkId } = useParams()
  const [params] = useSearchParams()
  if (authLoading) return <p className="no-result" role="status">로그인 상태 확인 중…</p>
  if (authError) return <p className="no-result" role="alert">{authError}</p>
  if (!uid) return <p className="no-result">로그인한 후 작품을 이용해 주세요. <Link to="/login">로그인</Link></p>
  return params.get('view') === 'server'
    ? <ConfirmedArtwork key={`${uid}:${artworkId}`} uid={uid} artworkId={artworkId} />
    : <WorkingArtwork uid={uid} artworkId={artworkId} />
}
