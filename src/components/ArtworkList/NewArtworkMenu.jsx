import { useRef, useState } from 'react'
import './NewArtworkMenu.css'
import { DEFAULT_ARTWORK, getArtworkErrorMessage, MAX_ARTWORK_DIMENSION, MAX_ARTWORK_TITLE_LENGTH } from '../../repositories/artworkRepository'

import { Blind } from '../mainComponents'

function NewArtworkMenu({ f, disabled = false }) {
  const [hide, setHide] = useState(true)
  const [values, setValues] = useState({ title: '', width: DEFAULT_ARTWORK.width, height: DEFAULT_ARTWORK.height })
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inFlight = useRef(false)
  const close = () => { if (!inFlight.current) setHide(true) }
  const updateValue = field => event => {
    setValues(previous => ({ ...previous, [field]: event.target.value }))
    setError('')
  }
  const handleCreate = async event => {
    event.preventDefault()
    if (inFlight.current || disabled) return
    inFlight.current = true
    setSubmitting(true)
    setError('')
    try {
      await f(values)
      setHide(true)
      setValues({ title: '', width: DEFAULT_ARTWORK.width, height: DEFAULT_ARTWORK.height })
    } catch (error) {
      setError(getArtworkErrorMessage(error))
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  return(
    <>
      <button className="new-button" disabled={disabled} onClick={() => { setError(''); setHide(false) }}>
        + 새 작품
      </button>
      <Blind 
        hide={hide}
        onClick={close}
      >
        <form className="new-artwork-menu" onSubmit={handleCreate} role="dialog" aria-modal="true" aria-labelledby="new-artwork-heading" aria-busy={submitting} onKeyDown={event => { if (event.key === 'Escape') close() }}>
          <h3 id="new-artwork-heading">새 작품</h3>
          <main>
            <div className="items">
              <label className="mini-title" htmlFor="new-artwork-title">제목</label>
              <div className="contents"><input id="new-artwork-title" type="text" placeholder="작품 제목" maxLength={MAX_ARTWORK_TITLE_LENGTH} value={values.title} onChange={updateValue('title')} disabled={submitting}/></div>
            </div>
            <div className="items">
              <div className="mini-title">프리셋</div>
              <div className="contents">
                <select aria-label="크기 프리셋" disabled>
                  <option>직접 입력</option>
                </select>
              </div>
            </div>
            <div className="items">
              <div className="mini-title">크기</div>
              <div className="contents size-input">
                <input type="number" aria-label="가로 픽셀" placeholder="가로" min="1" max={MAX_ARTWORK_DIMENSION} step="1" required value={values.width} onChange={updateValue('width')} disabled={submitting}/>
                <svg className="mul_icon" viewBox="0 0 32 32"><path stroke="#666" strokeWidth="5" d="m5 5 22 22M5 27 27 5"></path></svg>
                <input type="number" aria-label="세로 픽셀" placeholder="세로" min="1" max={MAX_ARTWORK_DIMENSION} step="1" required value={values.height} onChange={updateValue('height')} disabled={submitting}/>
              </div>
            </div>
          </main>
          {error && <p role="alert">{error}</p>}
          <div className="contents">
            <button className="cancel" type="button" onClick={close} disabled={submitting}>취소</button>
            <button className="confirm" type="submit" disabled={submitting || disabled}>{submitting ? '저장 중…' : '확인'}</button>
          </div>
        </form>
      </Blind>
    </>
  )
}

export default NewArtworkMenu
