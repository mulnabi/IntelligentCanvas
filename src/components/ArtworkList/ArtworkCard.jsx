function ArtworkCard({ artwork, onClick, onMore }) {
  const handleMore = (e) => {
    e.stopPropagation()
    onMore(artwork)
  }

  return (
    <div className="artwork-card" data-artwork-id={artwork.artworkId} role="button" tabIndex={0}
      aria-label={`${artwork.title} 열기`} onClick={() => onClick(artwork)}
      onKeyDown={event => {
        if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) {
          event.preventDefault()
          onClick(artwork)
        }
      }}>
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
            {new Date(artwork.updatedAt).toLocaleString('ko-KR')} · {artwork.width} × {artwork.height}px
          </div>
        </div>
        <button className="more-button" onClick={handleMore} aria-label={`${artwork.title} 관리`}>
          ⋮
        </button>
      </div>
    </div>
  )
}

export default ArtworkCard
