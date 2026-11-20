import { useState } from 'react'
import { Link, useNavigate } from 'react-router'

import ArtworkCard from '../components/ArtworkList/ArtworkCard'
import NewArtworkMenu from '../components/ArtworkList/NewArtworkMenu'
import ArtworkActions from '../components/ArtworkList/ArtworkActions'
import { useArtworks } from '../hook/useArtworks'
import { createArtwork, renameArtwork, deleteArtwork } from '../repositories/artworkRepository'
import './ArtworkList.css'

function ArtworkList({ uid, authLoading = false, authError = '' }) {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')

  const [sort, setSort] = useState('updatedAt')
  const [selected, setSelected] = useState(null)
  const { artworks, loading, error, retry } = useArtworks(uid, search, sort)
  const canUse = !!uid && !authLoading && !authError

  const handleNew = async values => {
    const artwork = await createArtwork(uid, values)
    setSearch('')
    setSort('updatedAt')
    return artwork // 생성 후 목록에 표시하고 카드를 선택하면 ID가 포함된 경로로 이동한다.
  }

  const handleOpen = (item) => {
    navigate(`/drawing/${encodeURIComponent(item.artworkId)}`)
  }

  return (
    <div className="artwork-page">
      <div className="page-top">
        <h2>내 작품</h2>
        <NewArtworkMenu f={handleNew} disabled={!canUse}/>
      </div>

      <div className="search-row">
        <input
          type="text"
          placeholder="작품 검색"
          aria-label="작품 검색"
          disabled={!canUse}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select aria-label="작품 정렬" value={sort} onChange={event => setSort(event.target.value)} disabled={!canUse}>
          <option value="updatedAt">최근 수정순</option>
          <option value="createdAt">최근 생성순</option>
          <option value="title">이름순</option>
        </select>
      </div>

      {authLoading ? <p className="no-result" role="status">로그인 상태 확인 중…</p>
        : authError ? <p className="no-result" role="alert">{authError}</p>
        : !uid ? <p className="no-result">로그인한 후 작품을 이용해 주세요. <Link to="/login">로그인</Link></p>
        : loading ? <p className="no-result" role="status">작품을 불러오는 중…</p>
        : error ? <p className="no-result" role="alert">{error} <button onClick={retry}>다시 시도</button></p>
        : artworks.length === 0 ? (
        <p className="no-result">{search.trim() ? '검색 결과가 없습니다' : '작품이 없습니다. 새 작품을 만들어 보세요.'}</p>
      ) : (
        <div className="artwork-grid">
          {artworks.map((item) => (
            <ArtworkCard key={item.artworkId} artwork={item} onClick={handleOpen} onMore={setSelected}/>
          ))}
        </div>
      )}
      {canUse && selected && <ArtworkActions key={selected.artworkId} artwork={selected}
        onRename={(id, title) => renameArtwork(uid, id, title)} onDelete={id => deleteArtwork(uid, id)} onClose={() => setSelected(null)}/>}
    </div>
  )
}

export default ArtworkList
