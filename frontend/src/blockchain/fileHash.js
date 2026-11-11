/**
 * SHA-256 of a File the visitor picked, formatted exactly like the backend's
 * hash_file() ("0x" + 64 hex) so the two can be compared directly. Runs entirely
 * in the browser via WebCrypto — the file is never uploaded anywhere.
 *
 * No ethers here, so hashing a file doesn't download it. anchor.js re-exports it.
 */
export async function sha256File(file) {
  const buffer = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return '0x' + hex
}
