import * as ort from 'onnxruntime-web'

const encoder = await ort.InferenceSession.create('./src/model/vit_encoder.onnx')

const head = await ort.InferenceSession.create('./src/model/vit_head.onnx')


function imageToTensor(canvas) {
  const temp = new OffscreenCanvas(224,224)
  const ctx = temp.getContext('2d', {willReadFrequently: true})

  ctx.fillStyle = 'white'
  ctx.fillRect(0,0,224,224)

  const scale = Math.min(224/canvas.width,224/canvas.height)
  const w = canvas.width*scale
  const h = canvas.height*scale

  ctx.drawImage(canvas,(224-w)/2,(224-h)/2,w,h)

  const pixels = ctx.getImageData(0,0,224,224).data
  const data = new Float32Array(3*224*224)

  for (let i = 0; i < 224*224; i++) {
    data[i] = pixels[i*4]/127.5-1
    data[i+224*224] = pixels[i*4+1]/127.5-1
    data[i+224*224*2] = pixels[i*4+2]/127.5-1
  }
  return new ort.Tensor('float32',data,[1,3,224,224])
}

async function predict(input) {
  const encoded = await encoder.run({
    [encoder.inputNames[0]]: imageToTensor(input)
  })

  const features = encoded[encoder.outputNames[0]]

  const classified = await head.run({
    [head.inputNames[0]]: features
  })
  let output=classified[head.outputNames[0]].data
  return output.indexOf(Math.max(...output))
}

export { predict };