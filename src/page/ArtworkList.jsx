import { useState } from 'react'
import { useNavigate } from "react-router";

import ArtworkCard from '../components/ArtworkList/ArtworkCard'
import NewArtworkMenu from '../components/ArtworkList/NewArtworkMenu'
import { artworks } from '../data/dummyData'
import './ArtworkList.css'

function ArtworkList() {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')

  // 검색어 들어간 것만 보여주기
  const filtered = artworks.filter((item) => item.title.includes(search))

  const handleNew = () => {
    navigate('/drawing')
  }

  const handleOpen = (item) => {
    console.log('열기', item)
  }

  return (
    <div className="artwork-page">
      <div className="page-top">
        <h2>내 작품</h2>
        <NewArtworkMenu f={handleNew}/>
      </div>

      <div className="search-row">
        <input
          type="text"
          placeholder="작품 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select>
          <option>최근 수정순</option>
          <option>이름순</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <p className="no-result">작품이 없습니다</p>
      ) : (
        <div className="artwork-grid">
          {filtered.map((item) => (
            <ArtworkCard key={item.id} artwork={item} onClick={handleOpen} />
          ))}
        </div>
      )}
    </div>
  )
}

export default ArtworkList
