import { BUILD } from './cqx-version.js'
import { READS_VERSION } from '../engine/cqx-reads.js'

// The web and API scorers share the same immutable input and cache namespace.
export const scoreCacheKey = (owner: string, repo: string, commit: string) =>
  `${owner}/${repo}@${commit}#${BUILD}:${READS_VERSION}`
