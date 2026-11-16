import { useState, useEffect, useRef } from 'react'
function DrawCanvas() {
  const [scale, setScale] = useState(Math.min(window.innerWidth / 800*0.8, window.innerHeight / 800*0.8));
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const pointer = useRef({ x: 0, y: 0, down: false }).current;

  const onPointerDown = e => {

  }

  const onPointerMove = e => {
    console.log(pointer)
  }

  const onPointerUp = e => {

  }

  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }, []);

  return (
    <div className="drawarea" onWheel={e => {
      const delta = e.deltaY > 0 ? scale/20 : -scale/20;
      let scaleValue = Math.min(Math.max(scale + delta, 0.1), 5);
      console.log(pointer.x)
      setPos({
        x: pos.x + pointer.x*(scale-scaleValue),
        y: pos.y + pointer.y*(scale-scaleValue)
      });
      setScale(scaleValue);
    }}
    onPointerDown={onPointerDown}
    onPointerMove={e => {
      pointer.x=(e.clientX-window.innerWidth/2-pos.x)/scale;
      pointer.y=(e.clientY-window.innerHeight/2-pos.y)/scale;
    }}
    >
      <canvas className="drawcanvas" width="800" height="800"
        style={{transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))scale(${scale})`}}
      ></canvas>
    </div>
  );
}

export default DrawCanvas;