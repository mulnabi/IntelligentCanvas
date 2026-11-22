import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router'
import { copyRecoveryDraft, getRecoveryDraft, listRecoveryDrafts } from '../../repositories/recoveryDraftRepository'

function DraftPreview({ uid, artworkId, draft }) {
  const preview = useRef(null)
  const [error, setError] = useState('')
  const { width, height, backgroundColor } = draft.artworkMetadataSnapshot
  const ratio = Math.min(1, 240 / Math.max(width, height))
  useEffect(() => {
    const canvas = preview.current
    const ctx = canvas.getContext('2d')
    let cancelled = false
    ctx?.clearRect(0, 0, canvas.width, canvas.height)
    void (async () => {
      if (!ctx) throw new Error('Canvas를 사용할 수 없습니다.')
      const { layersSnapshot, layerContentsSnapshot } = await getRecoveryDraft(uid, artworkId, draft.draftId)
      const contents = new Map(layerContentsSnapshot.map(row => [row.layerId, row.pngBlob]))
      for (const { layerId, visible, opacity } of [...layersSnapshot].reverse()) {
        if (cancelled) return
        if (!visible || !opacity || !contents.has(layerId)) continue
        const bitmap = await createImageBitmap(contents.get(layerId))
        try {
          if (cancelled) return
          if (bitmap.width !== width || bitmap.height !== height) throw new Error('레이어 크기가 일치하지 않습니다.')
          ctx.globalAlpha = opacity
          ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
        } finally { bitmap.close() }
      }
    })().catch(() => {
      if (!cancelled) {
        ctx?.clearRect(0, 0, canvas.width, canvas.height)
        setError('복구 초안을 미리 보지 못했습니다. 저장된 PNG는 유지됩니다.')
      }
    })
    return () => { cancelled = true }
  }, [uid, artworkId, draft.draftId, width, height])
  return <>
    <canvas ref={preview} aria-label="복구 초안 미리보기" width={Math.max(1, Math.round(width * ratio))}
      height={Math.max(1, Math.round(height * ratio))} style={{ backgroundColor }} />
    {error && <p role="alert">{error}</p>}
  </>
}

export default function RecoveryDrafts({ uid, artworkId }) {
  const [selected, setSelected] = useState(null)
  const [copy, setCopy] = useState(null)
  const drafts = useLiveQuery(() => listRecoveryDrafts(uid, artworkId).catch(() => null), [uid, artworkId])
  if (drafts === null) return <p role="alert">이 브라우저의 복구 초안을 확인하지 못했습니다.</p>
  if (!drafts?.length) return null
  return <details>
    <summary>이 브라우저의 복구 초안 ({drafts.length})</summary>
    {drafts.map(draft => <div key={draft.draftId}>
      <p>{draft.artworkMetadataSnapshot.title} · {new Date(draft.createdAt).toLocaleString()}</p>
      <p>레이어 {draft.layersSnapshot.map(row => row.name).join(', ')}</p>
      <button type="button" onClick={() => setSelected(selected === draft.draftId ? null : draft.draftId)}>
        {selected === draft.draftId ? '초안 닫기' : '초안 미리보기'}
      </button>
      {' '}<button type="button" disabled={copy?.busy} onClick={async () => {
        setCopy({ busy: true })
        try {
          setCopy({ artworkId: await copyRecoveryDraft(uid, artworkId, draft.draftId) })
        } catch {
          setCopy({ error: '복구본을 만들지 못했습니다. 초안은 이 브라우저에 남아 있습니다.' })
        }
      }}>별도 로컬 작품으로 복제</button>
      {selected === draft.draftId && <DraftPreview key={selected} uid={uid} artworkId={artworkId} draft={draft} />}
    </div>)}
    {copy?.artworkId && <p><Link to={`/drawing/${copy.artworkId}`}>복제한 로컬 작품 열기</Link></p>}
    {copy?.error && <p role="alert">{copy.error}</p>}
  </details>
}
