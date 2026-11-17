import './mainComponents.css'

export const Blind=({hide,onClick,children})=>(
  <div className={`blide ${hide ? 'hide' : 'show'}`} onClick={onClick}>
    <div onClick={(event)=>event.stopPropagation()}>
      {children}
    </div>
  </div>
)