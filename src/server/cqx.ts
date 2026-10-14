// Pages read scores produced by RepoIndex's background publication pipeline.
import {pageHealth} from './api/page-health.js'
import type { Report } from '../engine/cqx-report.js'

export { scoreNote, scoreUnavailable, CATEGORIES, type Category, type Report, type RuleHit } from '../engine/cqx-report.js'
export { UNSCORED } from '../engine/cqx-reads.js'


/** A missing prepared score returns Pending immediately; producers own work. */
export async function scoreCommit(owner: string, repo: string, commit: string): Promise<Report | null> {
  return (await pageHealth(owner,repo,commit)).report
}
export const scoreRead=pageHealth

export async function scoreHead(owner: string, repo: string, _ref: string, commit: string) {
  return scoreCommit(owner, repo, commit)
}
