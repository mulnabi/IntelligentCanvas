import { useRef, useState } from 'react'
import { Blind } from '../mainComponents'
import { getArtworkErrorMessage, MAX_ARTWORK_TITLE_LENGTH } from '../../repositories/artworkRepository'
import './NewArtworkMenu.css'

// 기존 새 작품 팝업의 배치와 스타일을 재사용한다.
export default function ArtworkActions({ artwork, onRename, onDelete, onClose }) {
  const [title, setTitle] = useState(artwork.title)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inFlight = useRef(false)
  const close = () => { if (!inFlight.current) onClose() }
  const save = async action => {
    if (inFlight.current) return
    inFlight.current = true
    setSubmitting(true)
    setError('')
    try {
      await action()
      onClose()
    } catch (error) {
      setError(getArtworkErrorMessage(error))
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }
  const handleDelete = () => {
    if (inFlight.current) return
    if (window.confirm(`“${artwork.title}” 작품을 삭제하시겠습니까? 목록에서 사라지며 현재 화면에서는 복원할 수 없습니다.`)) {
      void save(() => onDelete(artwork.artworkId))
    }
  }

  return <Blind hide={false} onClick={close}>
    <form className="new-artwork-menu" role="dialog" aria-modal="true" aria-labelledby="artwork-actions-heading"
      aria-busy={submitting} onSubmit={event => { event.preventDefault(); void save(() => onRename(artwork.artworkId, title)) }}
      onKeyDown={event => { if (event.key === 'Escape') close() }}>
      <h3 id="artwork-actions-heading">작품 관리</h3>
      <main>
        <div className="items">
          <label className="mini-title" htmlFor="rename-artwork-title">제목</label>
          <div className="contents"><input id="rename-artwork-title" value={title} maxLength={MAX_ARTWORK_TITLE_LENGTH}
            onChange={event => { setTitle(event.target.value); setError('') }} required disabled={submitting}/></div>
        </div>
      </main>
      {error && <p role="alert">{error}</p>}
      <div className="contents">
        <button type="button" className="cancel" onClick={close} disabled={submitting}>취소</button>
        <button type="button" className="cancel" onClick={handleDelete} disabled={submitting}>삭제</button>
        <button type="submit" className="confirm" disabled={submitting}>{submitting ? '저장 중…' : '제목 변경'}</button>
      </div>
    </form>
  </Blind>
}
