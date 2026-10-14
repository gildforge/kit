import { CloneView } from '../../presentation/Headers.js'
export function CloneButton({ owner, repo }: { owner: string; repo: string }) {
  return <CloneView owner={owner} repo={repo} />
}
