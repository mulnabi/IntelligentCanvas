import { useEffect, useRef, useState } from 'react'
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
  const [remoteError, setRemoteError] = useState('')
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
    visible.set(item.artworkId, confirmed ? { ...item, ...confirmed, remoteOnly: false } : item)
  }
  const text = search.normalize('NFKC').trim().toLowerCase()
  const items = [...visible.values()].filter(item => item.title.normalize('NFKC').toLowerCase().includes(text))
    .sort((a, b) => (sort === 'title' ? a.title.localeCompare(b.title, 'ko') : b[sort] - a[sort]) || a.artworkId.localeCompare(b.artworkId))
  const canUse = !!uid && !authLoading && !authError

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

  const refreshRemote = async (order = sort, cursor = null) => {
    setRemoteBusy(true)
    setRemoteError('')
    try {
      const deleted = new Set(await refreshServerDeletions(uid, remote.map(row => row.artworkId)))
      const page = await listServerArtworks(uid, { sort: order, cursor })
      setCatalog(current => {
        const previous = cursor ? current?.rows ?? [] : []
        const rows = new Map([...previous, ...page.rows].map(row => [row.artworkId, row]))
        for (const id of deleted) rows.delete(id)
        return { uid, rows: [...rows.values()], nextCursor: page.nextCursor }
      })
    }
    catch { setRemoteError('서버 작품 목록을 불러오지 못했습니다. 이 브라우저의 작품은 유지됩니다.') }
    finally { setRemoteBusy(false) }
  }

  const handleOpen = async (item) => {
    if (remoteBusy) return
    const { artworkId } = item
    const drawing = `/drawing/${encodeURIComponent(artworkId)}`
    const fromServerList = remote.some(row => row.artworkId === artworkId)
    setRemoteBusy(true)
    setRemoteError('')
    try {
      const state = item.remoteOnly ? null : await readArtworkSync(uid, artworkId)
      if ((fromServerList || state?.serverVersion > 0) && navigator.onLine
        && (await refreshServerDeletions(uid, [artworkId], false)).includes(artworkId)) {
        setCatalog(current => current && { ...current, rows: current.rows.filter(row => row.artworkId !== artworkId) })
        setRemoteError('서버에서 삭제된 작품입니다.')
        return
      }
      // 목록 조회 응답과 관계없이 확정본이 있는 깨끗한 캐시는 열기 전에 서버를 확인한다.
      const cleanCache = state?.serverVersion > 0 && state.localVersion === state.ackLocalVersion && !state.failure?.revoked
      if (fromServerList && !item.remoteOnly && !cleanCache) {
        navigate(`${drawing}?view=server`)
        return
      }
      const canRefresh = (fromServerList || navigator.onLine) && cleanCache
      if (item.remoteOnly || canRefresh) await downloadServerArtwork(uid, artworkId)
    } catch (error) {
      if (fromServerList) {
        if (error.code === 'sync/conflict') navigate(`${drawing}?view=server`)
        else setRemoteError(error.message)
        return
      }
      // 연결 실패나 경합 시 작업본을 유지하고 그림판의 권한 확인에 맡긴다.
    } finally { setRemoteBusy(false) }
    navigate(drawing)
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
          if (catalog) void refreshRemote(order)
        }}>
          <option value="updatedAt">최근 수정순</option>
          <option value="createdAt">최근 생성순</option>
          <option value="title">이름순</option>
        </select>
      </div>
      {canUse && <button disabled={remoteBusy} onClick={() => void refreshRemote()}>서버 작품 보기</button>}
      {canUse && catalog?.nextCursor?.sort === sort && <>
        {' '}<button disabled={remoteBusy} onClick={() => void refreshRemote(sort, catalog.nextCursor)}>서버 작품 더 보기</button>
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
            <ArtworkCard key={item.artworkId} artwork={item} onClick={handleOpen} disabled={remoteBusy}
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
