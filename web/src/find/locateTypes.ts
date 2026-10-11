// The contract of POST /api/locate (web/api/locate.ts), shared by the function and the client.
// The function imports this file as types only, so nothing from src/ is bundled into it.

/** What the app sends: the target's name and one to a few JPEG frames (base64, no "data:" prefix), in capture order. */
export interface LocateRequest {
  target: string
  frames: string[]
}

/** A box in the frame, as fractions of the frame (0 to 1) from the top-left corner. */
export interface LocateBox {
  x: number
  y: number
  width: number
  height: number
}

/** What comes back when the request worked. Not found is a normal answer, not an error. */
export type LocateResult =
  | { found: true; frameIndex: number; box: LocateBox; label: string; confidence: number }
  | { found: false }

export type LocateErrorKind =
  | 'bad-request' // the request was malformed or over the limits
  | 'not-configured' // no key, a refused key, or a model that does not exist
  | 'rate-limited' // the free tier is out of requests for now
  | 'unavailable' // Gemini or the network between the function and Gemini failed
  | 'bad-reply' // Gemini answered with something we cannot use
  | 'timeout' // the app gave up waiting
  | 'network' // the app could not reach the function

/** The JSON body of a failed request. The message is for the developer; the app speaks its own sentence. */
export interface LocateErrorBody {
  error: LocateErrorKind
  message: string
}
