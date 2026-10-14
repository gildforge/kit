import type { PageSession, PageViewer } from './page-reads.js'
import { resolvePicture, type ProfilePicture } from '../engine/profile.js'

export interface PageIdentity { name: string; picture?: ProfilePicture; claimed: boolean }

/** Shared presentation identity for Next and prepared documents. No authority is issued. */
export async function identityForPage(viewer: PageViewer | null, session: PageSession | null): Promise<PageIdentity | null> {
  if (viewer) {
    const profile = viewer.profile ? JSON.parse(viewer.profile) as { picture?: string | null } : null
    return { name: viewer.name, picture: await resolvePicture(profile?.picture, viewer.email), claimed: true }
  }
  if (!session) return null
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(session.publicKey)))
  const fingerprint = [...bytes.subarray(0, 4)].map(b => b.toString(16).padStart(2, '0')).join('')
  return { name: `key ${fingerprint}`, claimed: false }
}
