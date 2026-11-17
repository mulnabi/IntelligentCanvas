function ArtworkCard({ artwork, onClick }) {
  const handleMore = (e) => {
    e.stopPropagation()
    // TODO: 이름변경 / 복제 / 삭제 메뉴
    console.log('더보기', artwork.id)
  }

  return (
    <div className="artwork-card" onClick={() => onClick(artwork)}>
      <div className="thumb">
        {artwork.thumbnail ? (
          <img src={artwork.thumbnail} alt={artwork.title} />
        ) : (
          <div className="no-thumb">미리보기 없음</div>
        )}
      </div>
      <div className="card-bottom">
        <div>
          <div className="card-title">{artwork.title}</div>
          <div className="card-sub">
            {artwork.updatedAt} · 레이어 {artwork.layerCount}
          </div>
        </div>
        <button className="more-button" onClick={handleMore}>
          ⋮
        </button>
      </div>
    </div>
  )
}

export default ArtworkCard
