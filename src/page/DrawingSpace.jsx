import { useState, useRef } from 'react'
import { Link } from 'react-router'

import ToolPicker from '../components/DrawingSpace/ToolPicker'
import DrawCanvas from '../components/DrawingSpace/DrawCanavs'
import LayerMenu from '../components/DrawingSpace/LayerMenu'
import RecoveryDrafts from '../components/DrawingSpace/RecoveryDrafts'
import ArtworkHistory from '../components/DrawingSpace/ArtworkHistory'

import { useLayers } from '../hook/useLayers'
import { useCanvasPersistence } from '../hook/useCanvasPersistence'
import { useEditSession } from '../hook/useEditSession'
import { useArtworkSync } from '../hook/useArtworkSync'
import { getCanvasErrorMessage } from '../repositories/canvasRepository'
import { renameArtwork } from '../repositories/artworkRepository'


import './DrawingSpace.css'

function ArtworkEditor({ artwork, edit, serverSnapshot }) {
  const canvasApi = useRef(null)
  const [toolInfo, setToolInfo] = useState({tool: 'pen', color: '#000000'});
  const [inputError, setInputError] = useState('')
  const [retryingSize, setRetryingSize] = useState(false)
  const persistence = useCanvasPersistence(artwork, canvasApi, serverSnapshot)
  const sync = useArtworkSync(artwork.uid, artwork.artworkId, edit.proof)
  const localWriting = ['pending', 'saving', 'error'].includes(persistence.status)
  const statusText = { loading: '그림을 불러오는 중…', ready: '그리거나 레이어 설정을 바꾸면 자동 저장됩니다', pending: '저장 대기 중…', saving: '저장 중…', saved: '이 브라우저에 저장됨', error: '그림 처리 실패' }

  const layerState = useLayers(persistence)
  const activeLayer = layerState.layers.find(layer => layer.layerId === layerState.activeId)
  return (
    <>
      <ToolPicker f={setToolInfo} />
      <DrawCanvas toolInfo={toolInfo} artwork={artwork} canvasApi={canvasApi} activeLayer={activeLayer} readOnly={!edit.writable}
        onInputError={error => setInputError(error ? getCanvasErrorMessage(error) : '')} {...persistence}/>
      {persistence.ready && <LayerMenu {...layerState} disabled={persistence.locked || !edit.writable} />}
      {artwork && <aside aria-label="현재 작품 정보" data-artwork-id={artwork.artworkId} data-server-version={serverSnapshot?.serverVersion}
        style={{ position: 'fixed', left: 12, bottom: 12, zIndex: 2, maxWidth: 'calc(100% - 48px)', background: 'white', padding: '8px 12px', borderRadius: 8 }}>
        <strong>{artwork.title}</strong> · {artwork.width} × {artwork.height}px · <Link to="/">작품 목록</Link>
        {serverSnapshot && <p role="status">서버 확정본 · v{serverSnapshot.serverVersion} · 읽기 전용
          {sync.state && <> · <Link to={`/drawing/${encodeURIComponent(artwork.artworkId)}`}>이 브라우저의 작업본</Link></>}
        </p>}
        {(edit.writable || !persistence.ready) && <p role="status" aria-live="polite">{statusText[persistence.status]}</p>}
        {edit.status === 'occupied' && <p role="status">다른 기기에서 편집 중이므로 읽기 전용입니다.</p>}
        {edit.takeover && <button disabled={edit.busy || !sync.online || !persistence.ready} onClick={() => {
          if (window.confirm('다른 기기의 편집 권한을 무효화하고 마지막 서버 저장본에서 시작합니다. 기존 기기의 미동기화 변경은 그 기기에만 남습니다. 강제 복구하시겠습니까?')) {
            edit.recover(edit.takeover)
          }
        }}>강제 복구</button>}
        {edit.status === 'local' && <button onClick={edit.register} disabled={edit.busy || !persistence.ready}>서버에 저장</button>}
        {edit.status === 'available' && <button onClick={edit.acquire} disabled={edit.busy}>편집 세션 받기</button>}
        {edit.status === 'held' && <>
          <button onClick={edit.begin} disabled={edit.busy}>수정 시작</button>{' '}
          <button onClick={edit.release} disabled={edit.busy}>변경 없이 세션 반납</button>
        </>}
        {sync.state && !serverSnapshot && !sync.state.serverDeletedVersion && <>
          <p role="status">{sync.state.failure ? `${sync.state.failure.revoked ? '서버 동기화 중지' : '동기화 실패'} · ${sync.state.failure.message}`
            : sync.uploading ? '서버 업로드 중' : sync.pending || localWriting ? '서버 동기화 대기 중'
              : '서버 동기화 완료'}</p>
          {sync.state.failure && !sync.terminal && edit.proof && <button onClick={() => void sync.retry()}>동기화 다시 시도</button>}
          {sync.oversize && edit.proof && <>
            <p>8 MiB를 넘는 레이어를 수정해 로컬 저장을 마친 뒤 다시 시도해 주세요. 이전 요청은 복구 초안에 보존됩니다.</p>
            <button disabled={!sync.online || retryingSize || edit.busy} onClick={async () => {
              setInputError('')
              setRetryingSize(true)
              try { await sync.retryOversize() }
              catch (error) { setInputError(error.message) }
              finally { setRetryingSize(false) }
            }}>레이어 수정 후 동기화 다시 시도</button>
          </>}
          {edit.status === 'editing' && <>
            <button onClick={edit.finish} disabled={edit.busy || !sync.online || sync.terminal}>서버 저장 후 편집 종료</button>{' '}
            <button disabled={edit.busy || persistence.locked} onClick={() => {
              const title = window.prompt('작품 제목', artwork.title)
              if (title !== null) void renameArtwork(artwork.uid, artwork.artworkId, title).catch(error => setInputError(error.message))
            }}>작품 제목 변경</button>
          </>}
        </>}
        {edit.status === 'editing' && !sync.state && <p>서버 동기화 확인 전까지 이 세션은 반납할 수 없습니다.</p>}
        {edit.message && <p role="status">{edit.message}</p>}
        {['occupied', 'unavailable'].includes(edit.status) && <button onClick={edit.refresh} disabled={edit.busy}>편집 권한 다시 확인</button>}
        {(edit.status === 'revoked' || serverSnapshot || sync.state) && <>
          {!edit.busy && <RecoveryDrafts uid={artwork.uid} artworkId={artwork.artworkId} />}
          {edit.status === 'revoked' && edit.message.includes('다시 시도')
            && <button onClick={edit.refresh} disabled={edit.busy}>초안 보존 다시 시도</button>}
        </>}
        {(serverSnapshot || sync.state || ['available', 'occupied', 'held', 'editing', 'revoked'].includes(edit.status))
          && <ArtworkHistory artworkId={artwork.artworkId} version={serverSnapshot?.serverVersion ?? sync.state?.serverVersion} />}
        {persistence.error && <p role="alert">{persistence.error}{' '}
          {persistence.failure === 'save'
            ? <button onClick={persistence.retrySave}>다시 저장</button>
            : <button onClick={persistence.retryLoad}>다시 불러오기</button>}
        </p>}
        {persistence.blocked && <p>저장을 완료한 후 이동합니다. <button onClick={persistence.stay}>이 화면에 머무르기</button></p>}
        {inputError && !persistence.error && <p role="alert">{inputError} <button onClick={() => setInputError('')}>닫기</button></p>}
        {activeLayer?.visible === false && <p role="status">선택한 레이어가 숨겨져 있습니다. 다시 표시한 뒤 그려 주세요.</p>}
      </aside>}
    </>
  )
}

export default function DrawingSpace({ artwork, serverSnapshot }) {
  const edit = useEditSession(artwork.uid, artwork.artworkId, Boolean(serverSnapshot))
  if (edit.status === 'checking') return <p className="no-result" role="status">작품 편집 권한 확인 중…</p>
  return <ArtworkEditor key={edit.canvasEpoch} artwork={artwork} edit={edit} serverSnapshot={serverSnapshot} />
}
