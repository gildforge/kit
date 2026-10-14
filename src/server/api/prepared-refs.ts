import type {Context} from './dispatch.js'
import {paginate} from './dispatch.js'
import {apiURL,repoPath} from './shapes.js'
import {requireFound} from '../../engine/api/errors.js'
import type {PreparedRefs} from '../prepared-repository-producer.js'
export function preparedRefsResponse(c:Context,refs:PreparedRefs){
  const id=c.route.id,path=repoPath(c)
    if (id === 'branches')
      return paginate(
        refs.refs
          .filter((r) => r.kind === 'branch')
          .map((r) => ({
            name: r.name,
            commit: {
              sha: r.hash,
              url: apiURL(c, `${path}/commits/${r.hash}`),
            },
            protected: r.name === refs.defaultBranch,
          })),
        c,
      )
    const refShape = (r: (typeof refs.refs)[number]) => ({
      ref: `refs/${r.kind === 'branch' ? 'heads' : 'tags'}/${r.name}`,
      node_id: r.hash,
      url: apiURL(
        c,
        `${path}/git/ref/${r.kind === 'branch' ? 'heads' : 'tags'}/${r.name}`,
      ),
      object: {
        type: 'commit',
        sha: r.hash,
        url: apiURL(c, `${path}/git/commits/${r.hash}`),
      },
    })
    if (id === 'refs') return paginate(refs.refs.map(refShape), c)
    if (id === 'ref')
      return {
        data: refShape(
          requireFound(
            refs.refs.find(
              (r) =>
                `${r.kind === 'branch' ? 'heads' : 'tags'}/${r.name}` ===
                c.params.ref,
            ),
          ),
        ),
      }
  throw new Error('Unknown prepared refs operation')
}
