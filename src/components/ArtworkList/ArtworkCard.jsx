import { useEffect, useState } from 'react'
import { readArtworkPreview } from '../../repositories/layerRepository'

function ArtworkThumbnail({ uid, artworkId, title, thumbnail }) {
  const [preview, setPreview] = useState(null)

  useEffect(() => {
    if (!uid || thumbnail) return
    let active = true
    async function renderPreview() {
      const { artwork, images } = await readArtworkPreview(uid, artworkId)
      if (!active || !images.length) return
      const canvas = document.createElement('canvas')
      const scale = Math.min(1, 320 / Math.max(artwork.width, artwork.height))
      canvas.width = Math.max(1, Math.round(artwork.width * scale))
      canvas.height = Math.max(1, Math.round(artwork.height * scale))
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = artwork.backgroundColor
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      for (const { pngBlob, opacity } of images) {
        const image = await createImageBitmap(pngBlob, { resizeWidth: canvas.width, resizeHeight: canvas.height })
        try {
          if (!active) return
          ctx.globalAlpha = opacity
          ctx.drawImage(image, 0, 0)
        } finally {
          image.close()
        }
      }
      setPreview(canvas.toDataURL())
    }
    void renderPreview().catch(() => {})
    return () => { active = false }
  }, [uid, artworkId, thumbnail])

  const src = thumbnail || preview
  return src ? <img src={src} alt={title} /> : <div className="no-thumb">미리보기 없음</div>
}

function ArtworkCard({ artwork, uid, onClick, onMore, disabled = false }) {
  const handleMore = (e) => {
    e.stopPropagation()
    onMore(artwork)
  }

  return (
    <div className="artwork-card" data-artwork-id={artwork.artworkId} role="button" tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled} aria-label={`${artwork.title} 열기`} onClick={() => { if (!disabled) onClick(artwork) }}
      onKeyDown={event => {
        if (!disabled && event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) {
          event.preventDefault()
          onClick(artwork)
        }
      }}>
      <div className="thumb">
        <ArtworkThumbnail key={JSON.stringify([uid, artwork.artworkId, artwork.updatedAt])}
          uid={uid} artworkId={artwork.artworkId} title={artwork.title} thumbnail={artwork.thumbnail} />
      </div>
      <div className="card-bottom">
        <div>
          <div className="card-title">{artwork.title}</div>
          <div className="card-sub">
            {new Date(artwork.updatedAt).toLocaleString('ko-KR')} · {artwork.width} × {artwork.height}px
          </div>
        </div>
        {onMore && <button className="more-button" disabled={disabled} onClick={handleMore} aria-label={`${artwork.title} 관리`}>
          ⋮
        </button>}
      </div>
    </div>
  )
}

export default ArtworkCard
