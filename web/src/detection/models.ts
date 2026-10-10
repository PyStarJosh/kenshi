/** URL of the YOLO26n ONNX file for a square input size (320 or 416). */
export function modelUrl(size: number): string {
  return `${import.meta.env.BASE_URL}models/yolo26n-${size}.onnx`
}
