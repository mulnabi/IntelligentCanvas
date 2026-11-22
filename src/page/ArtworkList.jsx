import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import ArtworkCard from '../components/ArtworkList/ArtworkCard'
import NewArtworkMenu from '../components/ArtworkList/NewArtworkMenu'
import ArtworkActions from '../components/ArtworkList/ArtworkActions'
import { useArtworks } from '../hook/useArtworks'
import { createArtwork, renameArtwork, deleteArtwork } from '../repositories/artworkRepository'
import { readArtworkSync } from '../repositories/artworkSyncRepository'
import { deleteRegisteredArtwork, downloadServerArtwork, listServerArtworks, refreshServerDeletions } from '../services/artworkSyncService'
import './ArtworkList.css'

function ArtworkList({ uid, authLoading = false, authError = '' }) {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')

  const [sort, setSort] = useState('updatedAt')
  const [selected, setSelected] = useState(null)
  const [catalog, setCatalog] = useState(null)
  const { artworks, loading, error, retry } = useArtworks(uid, catalog?.uid === uid ? '' : search, sort)
  const [remoteBusy, setRemoteBusy] = useState(false)
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [remoteError, setRemoteError] = useState('')
  const pendingOpen = useRef(null)
  const catalogRequest = useRef({ latest: 0 })
  const deleteRequests = useRef(new Map())
  const remote = catalog?.uid === uid ? catalog.rows : []
  const visible = new Map(remote.map(row => [row.artworkId, { ...row, width: row.widthPx, height: row.heightPx, remoteOnly: true }]))
  for (const item of artworks) {
    if (item.serverDeletedVersion) {
      visible.delete(item.artworkId)
      continue
    }
    const confirmed = visible.get(item.artworkId)
    // 서버 목록의 표시 정보는 확정본을 따르며, 로컬 작업본은 열기 단계의 보호 로직에 맡긴다.
    visible.set(item.artworkId, confirmed ? { ...item, ...confirmed, remoteOnly: false, localUpdatedAt: item.updatedAt } : item)
  }
  const text = search.normalize('NFKC').trim().toLowerCase()
  const items = [...visible.values()].filter(item => item.title.normalize('NFKC').toLowerCase().includes(text))
    .sort((a, b) => (sort === 'title' ? a.title.localeCompare(b.title, 'ko') : b[sort] - a[sort]) || a.artworkId.localeCompare(b.artworkId))
  const canUse = !!uid && !authLoading && !authError

  useEffect(() => () => pendingOpen.current?.abort(), [])

  useEffect(() => {
    if (!canUse) return
    let active = true
    const reconcile = () => {
      void refreshServerDeletions(uid, catalog?.rows.map(row => row.artworkId)).then(ids => {
        if (!active || !ids.length) return
        setCatalog(current => {
          const rows = current?.rows.filter(row => !ids.includes(row.artworkId))
          return rows && rows.length !== current.rows.length ? { ...current, rows } : current
        })
      }).catch(() => {})
    }
    reconcile()
    window.addEventListener('online', reconcile)
    window.addEventListener('focus', reconcile)
    return () => {
      active = false
      window.removeEventListener('online', reconcile)
      window.removeEventListener('focus', reconcile)
    }
  }, [uid, canUse, catalog])

  const handleNew = async values => {
    const artwork = await createArtwork(uid, values)
    setSearch('')
    if (!catalog) setSort('updatedAt')
    return artwork // 생성 후 목록에 표시하고 카드를 선택하면 ID가 포함된 경로로 이동한다.
  }

  const refreshRemote = useCallback(async (order, cursor = null) => {
    const requests = catalogRequest.current
    const request = ++requests.latest
    try {
      const page = await listServerArtworks(uid, { sort: order, cursor })
      if (request !== requests.latest) return
      setCatalog(current => {
        const previous = cursor && current?.uid === uid ? current.rows : []
        const rows = new Map([...previous, ...page.rows].map(row => [row.artworkId, row]))
        return { uid, rows: [...rows.values()], nextCursor: page.nextCursor }
      })
    }
    catch {
      if (request === requests.latest && navigator.onLine) setRemoteError('서버 작품 목록을 불러오지 못했습니다.')
    }
    finally { if (request === requests.latest) setCatalogBusy(false) }
  }, [uid])

  useEffect(() => {
    if (!canUse) return
    const requests = catalogRequest.current
    const load = () => {
      if (navigator.onLine) void refreshRemote(sort)
    }
    load()
    window.addEventListener('online', load)
    window.addEventListener('focus', load)
    return () => {
      requests.latest++
      window.removeEventListener('online', load)
      window.removeEventListener('focus', load)
    }
  }, [canUse, refreshRemote, sort])

  const handleOpen = async (item) => {
    if (remoteBusy || pendingOpen.current) return
    const { artworkId } = item
    const drawing = `/drawing/${encodeURIComponent(artworkId)}`
    const serverItem = remote.find(row => row.artworkId === artworkId)
    const controller = new AbortController()
    const { signal } = controller
    pendingOpen.current = controller
    setRemoteBusy(true)
    setRemoteError('')
    try {
      const state = item.remoteOnly ? null : await readArtworkSync(uid, artworkId)
      signal.throwIfAborted()
      const deleted = (serverItem || state?.serverVersion > 0) && navigator.onLine
        ? await refreshServerDeletions(uid, [artworkId], false) : []
      signal.throwIfAborted()
      if (deleted.includes(artworkId)) {
        setCatalog(current => current && { ...current, rows: current.rows.filter(row => row.artworkId !== artworkId) })
        setRemoteError('서버에서 삭제된 작품입니다.')
        return
      }
      const hasLocalChanges = state && (state.localVersion !== state.ackLocalVersion || state.failure?.revoked)
      const matchesCache = serverItem && !item.remoteOnly &&
        (item.localUpdatedAt === serverItem.updatedAt || state?.serverVersion === serverItem.serverVersion)
      if (item.remoteOnly || navigator.onLine && !hasLocalChanges && !matchesCache && (serverItem || state?.serverVersion > 0)) {
        await downloadServerArtwork(uid, artworkId, signal)
      }
    } catch (error) {
      if (signal.aborted) return
      if (item.remoteOnly) {
        setRemoteError(error.message)
        return
      }
      // 연결 실패나 경합 시 작업본을 유지하고 그림판의 권한 확인에 맡긴다.
    } finally {
      pendingOpen.current = null
      if (!signal.aborted) setRemoteBusy(false)
    }
    if (!signal.aborted) navigate(drawing)
  }

  const handleDelete = async artworkId => {
    const state = await readArtworkSync(uid, artworkId)
    if (!state && selected.serverVersion == null) return deleteArtwork(uid, artworkId)
    const version = selected.serverVersion ?? state?.serverVersion
    const intent = JSON.stringify([artworkId, version])
    const requestId = deleteRequests.current.get(intent) ?? crypto.randomUUID()
    deleteRequests.current.set(intent, requestId)
    await deleteRegisteredArtwork(uid, artworkId, version, requestId)
    deleteRequests.current.delete(intent)
    setCatalog(current => current && { ...current, rows: current.rows.filter(row => row.artworkId !== artworkId) })
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
        <select aria-label="작품 정렬" value={sort} disabled={!canUse || remoteBusy} onChange={event => {
          const order = event.target.value
          setSort(order)
        }}>
          <option value="updatedAt">최근 수정순</option>
          <option value="createdAt">최근 생성순</option>
          <option value="title">이름순</option>
        </select>
      </div>
      {canUse && catalog?.uid === uid && catalog.nextCursor?.sort === sort && <>
        {' '}<button disabled={catalogBusy || remoteBusy} onClick={() => {
          setCatalogBusy(true)
          void refreshRemote(sort, catalog.nextCursor)
        }}>서버 작품 더 보기</button>
        <p>제목 검색은 로컬 작품과 현재까지 불러온 서버 작품에 적용됩니다.</p>
      </>}
      {remoteError && <p role="alert">{remoteError}</p>}

      {authLoading ? <p className="no-result" role="status">로그인 상태 확인 중…</p>
        : authError ? <p className="no-result" role="alert">{authError}</p>
        : !uid ? <p className="no-result">로그인한 후 작품을 이용해 주세요. <Link to="/login">로그인</Link></p>
        : loading ? <p className="no-result" role="status">작품을 불러오는 중…</p>
        : error ? <p className="no-result" role="alert">{error} <button onClick={retry}>다시 시도</button></p>
        : items.length === 0 ? (
        <p className="no-result">{search.trim() ? '검색 결과가 없습니다' : '작품이 없습니다. 새 작품을 만들어 보세요.'}</p>
      ) : (
        <div className="artwork-grid">
          {items.map((item) => (
            <ArtworkCard key={item.artworkId} uid={uid} artwork={item} onClick={handleOpen} disabled={remoteBusy}
              onMore={setSelected}/>
          ))}
        </div>
      )}
      {canUse && artworks.some(item => item.serverDeletedVersion) && <details>
        <summary>서버에서 삭제된 작품의 로컬 보존본</summary>
        <ul>{artworks.filter(item => item.serverDeletedVersion).map(item => <li key={item.artworkId}>
          <Link to={`/drawing/${encodeURIComponent(item.artworkId)}`}>{item.title}</Link>
        </li>)}</ul>
      </details>}
      {canUse && selected && <ArtworkActions key={selected.artworkId} artwork={selected}
        onRename={(id, title) => renameArtwork(uid, id, title)} onDelete={handleDelete} onClose={() => setSelected(null)}/>}
    </div>
  )
}

export default ArtworkList
