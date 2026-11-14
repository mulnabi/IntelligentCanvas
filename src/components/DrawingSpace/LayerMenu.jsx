import { useState } from 'react'

import LayerPanel from './LayerPanel'

function LayerMenu(props) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button className="layer-toggle" onClick={() => setOpen(true)}>
        <svg viewBox="0 0 32 32"><path d="M16 5l12 6-12 6-12-6 12-6ZM4 16l12 6 12-6M4 21l12 6 12-6"/></svg>
      </button>
      {open && (
        <aside className="layer-drawer">
          <LayerPanel {...props} Close={() => setOpen(false)} />
        </aside>
      )}
    </>
  )
}

export default LayerMenu
