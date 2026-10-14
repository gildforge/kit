'use client'

import { useState } from 'react'

/** The demo video: YouTube's thumbnail until clicked, then the player, so
 *  the landing page does not load YouTube for people who never press play. */
export function DemoVideo({ id, className }: { id: string; className?: string }) {
  const [playing, setPlaying] = useState(false)
  if (playing) {
    return (
      <div className={className}>
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1`}
          title="gild demo"
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
        />
      </div>
    )
  }
  return (
    <button
      type="button"
      className={className}
      onClick={() => setPlaying(true)}
      aria-label="Play the demo video"
      style={{
        cursor: 'pointer', padding: 0, display: 'grid', placeItems: 'center',
        backgroundImage: `url(https://i.ytimg.com/vi/${id}/maxresdefault.jpg)`,
        backgroundSize: 'cover', backgroundPosition: 'center',
      }}
    >
      <span
        style={{
          width: 84, height: 84, borderRadius: '50%', background: 'var(--accent)',
          display: 'grid', placeItems: 'center',
        }}
      >
        <svg width="30" height="30" viewBox="0 0 24 24" fill="var(--accent-ink)" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
      </span>
    </button>
  )
}
