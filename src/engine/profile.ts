export type { ProfilePicture } from './types.js'
import type { ProfilePicture } from './types.js'
import { avatarUrl } from './gravatar.js'
import { ApiError } from './api/errors.js'
export { profileSchema, profileInput } from './api/settings-contract.js'
export function webpBytes(data: string): Uint8Array {
  if (!data.startsWith('data:image/webp;base64,'))
    throw new ApiError(422, 'Upload a WebP picture')
  if (data.length > 23 + 4 * Math.ceil(65536 / 3))
    throw new ApiError(422, 'Picture must be a WebP of at most 64 KB')
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(data.slice(23)), (c) => c.charCodeAt(0))
  } catch {
    throw new ApiError(422, 'Invalid picture')
  }
  const str = (a: number, b: number) =>
      new TextDecoder().decode(bytes.subarray(a, b)),
    view = new DataView(bytes.buffer)
  if (
    bytes.length > 65536 ||
    bytes.length < 30 ||
    str(0, 4) !== 'RIFF' ||
    str(8, 12) !== 'WEBP' ||
    view.getUint32(4, true) + 8 !== bytes.length
  )
    throw new ApiError(422, 'Picture must be a WebP of at most 64 KB')
  let width = 0,
    height = 0
  const chunk = str(12, 16)
  if (chunk === 'VP8X') {
    width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16)
    height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)
    if (bytes[20] & 2)
      throw new ApiError(422, 'Animated pictures are not supported')
  } else if (
    chunk === 'VP8 ' &&
    bytes[23] === 157 &&
    bytes[24] === 1 &&
    bytes[25] === 42
  ) {
    width = view.getUint16(26, true) & 0x3fff
    height = view.getUint16(28, true) & 0x3fff
  } else if (chunk === 'VP8L' && bytes[20] === 47) {
    const bits = view.getUint32(21, true)
    width = (bits & 0x3fff) + 1
    height = ((bits >>> 14) & 0x3fff) + 1
  }
  if (!width || !height || width > 256 || height > 256)
    throw new ApiError(422, 'Picture must be at most 256 × 256 pixels')
  return bytes
}
export async function pictureHash(bytes: Uint8Array) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Resolve on the server: only the resulting hash URL crosses the client boundary. */
export async function resolvePicture(
  picture: string | null | undefined,
  email?: string | null,
  size = 256,
): Promise<ProfilePicture> {
  if (picture) return { url: picture, source: 'Uploaded' }
  if (email?.trim())
    return { url: await avatarUrl(email, size), source: 'Gravatar' }
  return { url: null, source: 'None' }
}
