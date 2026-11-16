import { useState, useRef } from 'react'
function DrawCanvas({ toolInfo }) {
  const [scale, setScale] = useState(Math.min(window.innerWidth / 800*0.8, window.innerHeight / 800*0.8));
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const pointer = useRef({ x: 0, y: 0, down: false }).current;

  // ------ 추가-1 ------
  const canvas = useRef(null);

  const updatePointer = e => {
    pointer.x=(e.clientX-window.innerWidth/2-pos.x)/scale;
    pointer.y=(e.clientY-window.innerHeight/2-pos.y)/scale;
  }
  // ---------------------

  const onPointerDown = e => {
    // ------ 추가-2 ------
    if(e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    updatePointer(e);
    pointer.down = true;

    const ctx = canvas.current.getContext('2d');
    ctx.globalCompositeOperation = toolInfo.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.lineWidth = toolInfo.tool === 'eraser' ? 20 : 4;
    ctx.lineCap = 'round';
    ctx.strokeStyle = toolInfo.color;
    ctx.fillStyle = toolInfo.color;

    ctx.beginPath();
    ctx.arc(pointer.x+400,pointer.y+400,2,0,Math.PI*2);
    ctx.fill();
    // ---------------------
  }

  const onPointerMove = e => {
    // ------ 추가-3 ------
    const x = pointer.x;
    const y = pointer.y;
    updatePointer(e);

    if(!pointer.down) return;

    const ctx = canvas.current.getContext('2d');
    ctx.beginPath();
    ctx.moveTo(x+400,y+400);
    ctx.lineTo(pointer.x+400,pointer.y+400);
    ctx.stroke();
    // ---------------------
  }

  const onPointerUp = e => {
    // ------ 추가-4 ------
    pointer.down = false;
    // ---------------------
  }

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
    onPointerMove={onPointerMove}
    onPointerUp={onPointerUp}
    onPointerCancel={onPointerUp}
    >
      <canvas ref={canvas} className="drawcanvas" width="800" height="800"
        style={{transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))scale(${scale})`}}
      ></canvas>
    </div>
  );
}

export default DrawCanvas;