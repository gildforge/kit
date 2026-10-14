'use client'
import { useState } from 'react'
import type { ProfilePicture } from '../engine/types.js'
import s from './styles/settings.module.css'

/** Every identity picture shares the same theme-aware silhouette and error fallback. */
export function Picture({
  name,
  picture,
  org = false,
  className,
  size,
  showSource = false,
}: {
  name: string
  picture?: ProfilePicture
  org?: boolean
  className?: string
  size?: number
  showSource?: boolean
}) {
  const url = picture?.url ?? null
  const [image, setImage] = useState({ url, failed: false })
  // Reset only when the URL changes, never after an initial image-error event.
  if (image.url !== url) setImage({ url, failed: false })
  const visible = url && !(image.url === url && image.failed)
  const source = visible ? picture!.source : 'None'
  return (
    <>
      <span
        className={`${s.picture} ${className ?? ''}`}
        role="img"
        aria-label={`Profile picture for ${name}`}
        data-picture-source={source}
        style={{
          ...(size ? { width: size, height: size } : {}),
          borderRadius: org ? undefined : '50%',
          display: 'inline-flex',
          overflow: 'hidden',
          background: 'var(--panel)',
          color: 'var(--ink-dim)',
        }}
      >
        {visible ? (
          <img
            src={url}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            ref={(node) => {
              // A server-rendered image can fail before hydration attaches onError.
              if (node?.complete && !node.naturalWidth)
                setImage((current) =>
                  current.url === url ? { url, failed: true } : current,
                )
            }}
            onError={() =>
              setImage((current) =>
                current.url === url ? { url, failed: true } : current,
              )
            }
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <svg
            viewBox="0 0 24 24"
            width="100%"
            height="100%"
            aria-hidden="true"
            fill="currentColor"
          >
            {org ? (
              <path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16h-5v-5h-4v5H5Zm3-15v2h2V6H8Zm6 0v2h2V6h-2Zm-6 5v2h2v-2H8Zm6 0v2h2v-2h-2Z" />
            ) : (
              <>
                <circle cx="12" cy="8" r="4" />
                <path d="M4 23v-3a8 8 0 0 1 16 0v3Z" />
              </>
            )}
          </svg>
        )}
      </span>
      {showSource && (
        <span className={s.dim} data-picture-label>
          {source}
          {source === 'None' && (
            <>
              {' '}
              ·{' '}
              <a href="https://gravatar.com" target="_blank" rel="noreferrer">
                Set up Gravatar
              </a>
            </>
          )}
        </span>
      )}
    </>
  )
}
