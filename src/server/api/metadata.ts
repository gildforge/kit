import {
  DIR,
  newId,
  nextNumber,
  readJson,
  stamp,
  writeJson,
  writeMeta,
  logEvent,
} from '../metastore.js'
import type { Issue, Comment } from '../issues.js'
import type { Pull, Review } from '../pulls.js'
import { ApiError } from '../../engine/api/errors.js'
export async function createIssueRecord(
  owner: string,
  repo: string,
  author: string,
  title: string,
  body: string,
  labels: string[],
) {
  return writeMeta(
    owner,
    repo,
    `issue: open "${title}"`,
    author,
    async (fs) => {
      const number = await nextNumber(fs),
        issue: Issue = {
          schema: 1,
          number,
          title,
          body,
          author,
          createdAt: stamp(),
          state: 'open',
          labels,
          claim: null,
        }
      await writeJson(fs, `${DIR}/.gild/${number}/issue/issue.json`, issue)
      return issue
    },
  )
}
export async function updateItem(
  owner: string,
  repo: string,
  number: number,
  by: string,
  kind: 'issue' | 'pr',
  patch: {
    title?: string
    body?: string
    state?: 'open' | 'closed'
    labels?: string[]
    base?: string
  },
) {
  return writeMeta(
    owner,
    repo,
    `${kind} #${number}: update`,
    by,
    async (fs) => {
      const path = `${DIR}/.gild/${number}/${kind}/${kind}.json`,
        item = await readJson<Issue | Pull>(fs, path)
      if (!item) throw new ApiError(404, 'Not Found')
      if (item.state === 'merged')
        throw new ApiError(409, 'A merged pull request is immutable')
      Object.assign(item, patch)
      if (kind === 'pr' && patch.state === 'closed') {
        const queue =
          (await readJson<number[]>(fs, `${DIR}/.gild/queue.json`)) ?? []
        await writeJson(
          fs,
          `${DIR}/.gild/queue.json`,
          queue.filter((n) => n !== number),
        )
      }
      await writeJson(fs, path, item)
      await logEvent(fs, number, { kind: 'edited', by })
      return item
    },
  )
}
export interface InlineComment extends Comment {
  path: string
  line: number
  side: 'LEFT' | 'RIGHT'
  commit_id: string
}
export async function addInlineComment(
  owner: string,
  repo: string,
  number: number,
  author: string,
  input: Omit<InlineComment, 'id' | 'author' | 'createdAt'>,
) {
  return writeMeta(
    owner,
    repo,
    `pr #${number}: inline comment`,
    author,
    async (fs) => {
      if (!(await readJson<Pull>(fs, `${DIR}/.gild/${number}/pr/pr.json`)))
        throw new ApiError(404, 'Not Found')
      const comment: InlineComment = {
        ...input,
        id: newId(),
        author,
        createdAt: stamp(),
      }
      await writeJson(
        fs,
        `${DIR}/.gild/${number}/pr/c-${Date.now()}-${comment.id}.json`,
        comment,
      )
      return comment
    },
  )
}
