import { useEffect, useState } from 'react'
import { callEditSession } from '../../services/editSessionService'

export default function ArtworkHistory({ artworkId, version }) {
  const [open, setOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState(null)
  useEffect(() => {
    if (!open) return
    let current = true
    void callEditSession('listArtworkRevisions', artworkId).then(rows => {
      if (current) setResult({ rows })
    }).catch(error => {
      if (current) setResult(error.code === 'functions/not-found' ? { rows: [] }
        : { error: '수정 이력을 불러오지 못했습니다. 연결을 확인해 주세요.' })
    })
    return () => { current = false }
  }, [artworkId, version, open, attempt])

  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>수정 이력</summary>
    {open && <div style={{ maxHeight: 200, overflowY: 'auto' }}>
      {!result ? <p role="status">수정 이력을 불러오는 중…</p>
        : result.error ? <p role="alert">{result.error}{' '}
          <button onClick={() => { setResult(null); setAttempt(value => value + 1) }}>다시 조회</button></p>
          : !result.rows.length ? <p>서버에 저장된 수정 이력이 없습니다.</p>
            : <ol>
              {result.rows.map(row => <li key={row.revisionId}>
                <time dateTime={new Date(row.createdAt).toISOString()}>{new Date(row.createdAt).toLocaleString()}</time>
                {' · '}v{row.serverVersion}
                <ul>
                  {row.changedLayers.map(layer => <li key={layer.layerId}>{layer.name} 레이어 {layer.description}</li>)}
                  {row.operationTypes.includes('artwork_metadata_changed') && <li>작품 정보 변경</li>}
                </ul>
              </li>)}
            </ol>}
    </div>}
  </details>
}
