import { Link, useParams } from 'react-router'
import { useArtwork } from '../hook/useArtworks'
import DrawingSpace from './DrawingSpace'

// 라우트 경계에서 ID와 현재 UID를 검증한다. Canvas와 레이어 동작은 건드리지 않는다.
export default function ArtworkDrawingPage({ uid, authLoading = false, authError = '' }) {
  const { artworkId } = useParams()
  const { artwork, loading, error, retry } = useArtwork(uid, artworkId)
  if (authLoading) return <p className="no-result" role="status">로그인 상태 확인 중…</p>
  if (authError) return <p className="no-result" role="alert">{authError}</p>
  if (!uid) return <p className="no-result">로그인한 후 작품을 이용해 주세요. <Link to="/login">로그인</Link></p>
  if (loading) return <p className="no-result" role="status">작품을 불러오는 중…</p>
  if (error || !artwork) return <p className="no-result" role="alert">
    {error || '작품을 열 수 없습니다.'} <button onClick={retry}>다시 시도</button> <Link to="/">작품 목록</Link>
  </p>
  return <DrawingSpace key={`${uid}:${artwork.artworkId}:${artwork.width}:${artwork.height}`} artwork={artwork}/>
}
