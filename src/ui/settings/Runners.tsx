'use client'
import { ago } from '../../engine/time.js'
import { useEffect, useState } from 'react'
import Link from '../Link.js'
import s from '../../render/styles/settings.module.css'
import r from './runners.module.css'
import type { RunnerGroup } from '../../engine/actions/pool-store.js'
interface RunnerView {
  gild_id: string
  name: string
  os: string
  arch?: string
  labels: { name: string }[]
  status: string
  busy: boolean
  last_seen?: number
  group?: string
  group_name?: string
  assignment?: { repository: string; job: number; run: number } | null
  inherited?: boolean
  eligible?: boolean
  ineligible_reason?: string | null
}
export async function runnerCall(path: string, method = 'GET', body?: unknown) {
  // Idempotent calls retry transient edge failures: the local worker transport
  // sometimes drops an in-flight request (CI: a 500 "Network connection lost"
  // on the label-save PATCH), which must not strand the dialog on an error —
  // or, when the response is lost after commit, look like the save failed.
  const idempotent = ['GET', 'PATCH', 'PUT', 'DELETE'].includes(method)
  for (let attempt = 1; ; attempt++) {
    let response: Response
    try {
      response = await fetch('/api/runner-settings' + path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      })
    } catch (e) {
      if (idempotent && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
        continue
      }
      throw e
    }
    if (idempotent && attempt < 3 && (response.status === 429 || response.status >= 500)) {
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
      continue
    }
    const data = await response.json()
    if (!response.ok) throw Error(data.message ?? `HTTP ${response.status}`)
    return data
  }
}
function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className={r.code}>
      <code>{children}</code>
      <button
        aria-label="Copy command"
        onClick={() =>
          void navigator.clipboard
            .writeText(children)
            .then(() => setCopied(true))
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
function Machine() {
  return (
    <svg
      aria-hidden
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  )
}
export function RunnerPanel({
  owner,
  kind,
  repo,
  base,
  view = 'runners',
  path = [],
  repositories = [],
  initialGroup = 'default',
}: {
  owner: string
  kind: 'org' | 'user'
  repo?: string
  base: string
  view?: 'runners' | 'runner-groups'
  path?: string[]
  initialGroup?: string
  repositories?: { name: string; private: boolean }[]
}) {
  const api = repo
      ? `/repos/${owner}/${repo}/actions`
      : `/${kind === 'org' ? 'orgs' : 'users'}/${owner}/actions`,
    ownerBase = kind === 'org' ? `/orgs/${owner}/settings` : '/settings'
  const [runners, setRunners] = useState<RunnerView[]>([]),
    [groups, setGroups] = useState<RunnerGroup[]>([]),
    [error, setError] = useState(''),
    [search, setSearch] = useState(''),
    [loaded, setLoaded] = useState(false)
  const [edit, setEdit] = useState<{
      runner: RunnerView
      mode: 'group' | 'labels'
    } | null>(null),
    [newGroup, setNewGroup] = useState(false),
    [token, setToken] = useState<{ token: string; expires_at: string } | null>(
      null,
    )
  const [os, setOs] = useState(path[1] ?? 'macos'),
    [arch, setArch] = useState('arm64'),
    [name, setName] = useState('runner'),
    [group, setGroup] = useState(initialGroup || 'default'),
    [selected, setSelected] = useState<RunnerGroup | null>(null),
    [jobs, setJobs] = useState<
      {
        repository: string
        run: number
        job: number
        status: string
        name: string
      }[]
    >([])
  useEffect(() => setGroup(initialGroup || 'default'), [initialGroup])
  const setup = path[0] === 'new',
    groupId = view === 'runner-groups' ? path[0] : undefined,
    recent = path[0] === 'jobs' ? path[1] : undefined
  async function reload() {
    const data = await runnerCall(api + '/runners' + (repo ? '?per_page=100' : ''))
    const list = [...data.runners]
    for (let page = 2; list.length < data.total_count; page++) {
      const next = await runnerCall(api + '/runners?per_page=100&page=' + page)
      if (!next.runners.length) break
      list.push(...next.runners)
    }
    setRunners(list)
    if (!repo) {
      const data = await runnerCall(api + '/runner-groups')
      setGroups(data.runner_groups)
      setGroup(current => data.runner_groups.some((g: RunnerGroup) => g.id === current) ? current : 'default')
    }
    setLoaded(true)
  }
  async function perform(fn: () => Promise<void>) {
    setError('')
    try {
      await fn()
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => {
    let active = true
    const refresh = () => {
      if (document.visibilityState === 'visible')
        void reload().catch((e) => {
          if (active) setError(e.message)
        })
    }
    refresh()
    const timer = setInterval(refresh, 10000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      active = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [api])
  useEffect(() => {
    if (groupId)
      void runnerCall(api + '/runner-groups/' + groupId)
        .then(setSelected)
        .catch((e) => setError(e.message))
  }, [api, groupId])
  useEffect(() => {
    if (recent)
      void runnerCall(api + '/runners/' + recent + '/jobs')
        .then((d) => setJobs(d.jobs))
        .catch((e) => setError(e.message))
  }, [api, recent])
  // The setup page mints on arrival and whenever the bound group changes.
  // Tokens stay in component state, never in URLs or persistent browser storage.
  useEffect(() => {
    if (!setup) return
    let active = true
    setToken(null)
    void runnerCall(
      api + '/runners/registration-token',
      'POST',
      repo ? {} : { group },
    )
      .then((t) => {
        if (active) setToken(t)
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
    }
  }, [api, setup, group])
  const shown = runners.filter((x) =>
      (x.name + ' ' + x.labels.map((l) => l.name).join(' '))
        .toLowerCase()
        .includes(search.toLowerCase()),
    ),
    eligible = shown.filter((x) => x.eligible !== false)
  function row(x: RunnerView) {
    const state =
      x.status === 'offline' ? 'Offline' : x.busy ? 'Active' : 'Idle'
    return (
      <div className={r.row} key={x.gild_id}>
        <Machine />
        <div className={r.machine}>
          <strong>{x.name}</strong>
          <div className={r.chips}>
            {x.labels.map((l) => (
              <span key={l.name}>
                {(
                  {
                    macos: 'macOS',
                    linux: 'Linux',
                    windows: 'Windows',
                    arm64: 'ARM64',
                    x64: 'X64',
                  } as Record<string, string>
                )[l.name] ?? l.name}
              </span>
            ))}
          </div>
          {x.group && (
            <div className={s.dim}>
              {repo ? (
                <>
                  from <Link href={ownerBase + '/runners'}>@{owner}</Link> ·{' '}
                  <Link href={ownerBase + '/runner-groups/' + x.group}>
                    {x.group_name}
                  </Link>
                </>
              ) : (
                <>
                  Runner group:{' '}
                  <Link href={base + '/runner-groups/' + x.group}>
                    {x.group_name}
                  </Link>
                </>
              )}
            </div>
          )}
        </div>
        <div className={r.status}>
          <span
            className={`${r.dot} ${state === 'Idle' ? r.idle : state === 'Active' ? r.active : r.offline}`}
          />
          {state === 'Active' && x.assignment ? (
            <Link
              href={`/${x.assignment.repository}/actions/${x.assignment.run}`}
            >
              Active · job #{x.assignment.job}
            </Link>
          ) : (
            state
          )}
          {state === 'Offline' && (
            <small>
              {x.last_seen
                ? <time dateTime={new Date(x.last_seen).toISOString()} title={new Date(x.last_seen).toLocaleString()}>Last seen {ago(x.last_seen, Date.now(), true)}</time>
                : 'Not connected yet'}
            </small>
          )}
        </div>
        {!x.inherited && (
          <details className={r.actions}>
            <summary aria-label={'Actions for ' + x.name}>⋯</summary>
            <div role="menu">
              {!repo && (
                <button
                  role="menuitem"
                  onClick={() => setEdit({ runner: x, mode: 'group' })}
                >
                  Move to group
                </button>
              )}
              <Link role="menuitem" href={base + '/runners/jobs/' + x.gild_id}>
                Recent jobs
              </Link>
              {
                <button
                  role="menuitem"
                  onClick={() => setEdit({ runner: x, mode: 'labels' })}
                >
                  Edit labels
                </button>
              }
              <button
                className={s.dangerButton}
                role="menuitem"
                onClick={() => {
                  if (
                    confirm(
                      'Remove ' +
                        x.name +
                        '? Running jobs finish; it cannot lease another job.',
                    )
                  )
                    void perform(async () => {
                      await runnerCall(api + '/runners/' + x.gild_id, 'DELETE')
                    })
                }}
              >
                Remove runner
              </button>
            </div>
          </details>
        )}
      </div>
    )
  }
  return (
    <>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      {setup ? (
        <>
          <div className={s.dim}>
            <Link href={base + '/runners'}>Runners</Link> / New runner
          </div>
          <h1>New runner</h1>
          <div className={r.controls}>
            <label>
              Operating system
              <select value={os} onChange={(e) => setOs(e.target.value)}>
                <option value="macos">macOS</option>
                <option value="linux">Linux</option>
                <option value="windows">Windows</option>
              </select>
            </label>
            <label>
              Architecture
              <select value={arch} onChange={(e) => setArch(e.target.value)}>
                <option value="arm64">ARM64</option>
                <option value="x64">X64</option>
              </select>
            </label>
            {!repo && (
              <label>
                Runner group
                <select
                  aria-label="Runner group"
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                >
                  {!groups.length && <option value={group}>{group === 'default' ? 'Default' : 'Loading group…'}</option>}
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                pattern="[a-zA-Z0-9][\w.-]{0,63}"
              />
            </label>
          </div>
          <ol className={r.steps}>
            <li>
              <strong>Install the gild CLI on the machine</strong>
              <Code>npm install -g gildforge</Code>
            </li>
            <li>
              <strong>Register it</strong>
              {token && (
                <>
                  <Code>{`gild runner add --${repo ? 'repo' : kind} ${repo ? owner + '/' + repo : owner}${repo ? '' : ' --group ' + group} --name ${/^[a-zA-Z0-9][\w.-]{0,63}$/.test(name) ? name : 'runner'} --token ${token.token}`}</Code>
                  <span className={s.dim}>
                    Works once · expires{' '}
                    {new Date(token.expires_at).toLocaleTimeString()}{' '}
                  </span>
                  <button
                    onClick={() =>
                      void perform(async () =>
                        setToken(
                          await runnerCall(
                            api + '/runners/registration-token',
                            'POST',
                            repo ? {} : { group },
                          ),
                        ),
                      )
                    }
                  >
                    New token
                  </button>
                </>
              )}
            </li>
            <li>
              <strong>Run it as a service</strong>
              <Code>{`gild runner service install --name ${/^[a-zA-Z0-9][\w.-]{0,63}$/.test(name) ? name : 'runner'}`}</Code>
              <span className={s.dim}>
                {os === 'macos'
                  ? 'Starts at login and restarts if it stops (launchd).'
                  : os === 'linux'
                    ? 'Starts at login (systemd user service). Enable user lingering for startup before login.'
                    : 'Run installation in an elevated terminal; Windows requests the service account credentials.'}
              </span>
              <Code>{`gild runner start --name ${/^[a-zA-Z0-9][\w.-]{0,63}$/.test(name) ? name : 'runner'}`}</Code>
            </li>
            <li>
              <div className={r.waiting}>
                {runners.find((x) => x.name === name && x.status === 'online')
                  ? `${name} is connected`
                  : `Waiting for ${name} to connect…`}
              </div>
            </li>
            <li>
              <strong>Use it in a workflow</strong>
              <Code>{`jobs:\n  test:\n    runs-on: [self-hosted, ${os}, ${arch}]`}</Code>
            </li>
          </ol>
        </>
      ) : recent ? (
        <>
          <h1>Recent jobs</h1>
          <div className={s.table}>
            {jobs.map((j) => (
              <div className={s.row} key={j.repository + ':' + j.job}>
                <Link href={`/${j.repository}/actions/${j.run}`}>
                  {j.repository} · {j.name}
                </Link>
                <span>{j.status}</span>
              </div>
            ))}
            {!jobs.length && <div className={s.row}>No recent jobs</div>}
          </div>
        </>
      ) : view === 'runner-groups' ? (
        selected ? (
          <>
            <div className={s.dim}>
              <Link href={base + '/runner-groups'}>Runner groups</Link> /{' '}
              {selected.name}
            </div>
            <h1>{selected.name}</h1>
            <form
              className={s.form}
              onSubmit={(e) => {
                e.preventDefault()
                void perform(async () => {
                  await runnerCall(
                    api + '/runner-groups/' + selected.id,
                    'PATCH',
                    selected,
                  )
                })
              }}
            >
              <label>
                Group name
                <input
                  value={selected.name}
                  disabled={selected.id === 'default'}
                  onChange={(e) =>
                    setSelected({ ...selected, name: e.target.value })
                  }
                />
              </label>
              <h2>Repository access</h2>
              <label>
                Repository access
                <select
                  value={selected.visibility}
                  onChange={(e) =>
                    setSelected({
                      ...selected,
                      visibility: e.target.value as 'all' | 'selected',
                    })
                  }
                >
                  <option value="all">All repositories</option>
                  <option value="selected">Selected repositories</option>
                </select>
              </label>
              {selected.visibility === 'selected' && (
                <div className={s.table}>
                  {repositories.map((repo) => (
                    <label className={r.pickerRow} key={repo.name}>
                      <input
                        type="checkbox"
                        checked={selected.repositories.includes(
                          owner + '/' + repo.name,
                        )}
                        onChange={(e) =>
                          setSelected({
                            ...selected,
                            repositories: e.target.checked
                              ? [
                                  ...selected.repositories,
                                  owner + '/' + repo.name,
                                ]
                              : selected.repositories.filter(
                                  (x) => x !== owner + '/' + repo.name,
                                ),
                          })
                        }
                      />
                      <strong>{repo.name}</strong>
                      <span className={s.dim}>
                        {repo.private ? 'private' : 'public'}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <label className={r.publicSwitch}>
                <input
                  type="checkbox"
                  role="switch"
                  checked={selected.allow_public_repositories}
                  onChange={(e) =>
                    setSelected({
                      ...selected,
                      allow_public_repositories: e.target.checked,
                    })
                  }
                />
                <span>
                  Allow public repositories
                  <small>
                    Pull requests from forks can run code on these machines.
                    Fork runs wait for a maintainer’s approval.
                  </small>
                </span>
              </label>
              <div>
                <button className={s.primary}>Save group</button>
                {selected.id !== 'default' && (
                  <button
                    type="button"
                    className={s.dangerButton}
                    onClick={() =>
                      void perform(async () => {
                        await runnerCall(
                          api + '/runner-groups/' + selected.id,
                          'DELETE',
                        )
                        location.href = base + '/runner-groups'
                      })
                    }
                  >
                    Delete group
                  </button>
                )}
              </div>
            </form>
            <h2>Runners in this group</h2>
            <div className={r.table}>
              {runners.filter((x) => x.group === selected.id).map(row)}
            </div>
            <Link
              className={s.button}
              href={base + '/runners/new/macos?group=' + selected.id}
            >
              Add a runner to this group
            </Link>
          </>
        ) : (
          <>
            <div className={r.heading}>
              <h1>Runner groups</h1>
              <button className={s.primary} onClick={() => setNewGroup(true)}>
                New group
              </button>
            </div>
            <div className={r.table}>
              <div className={r.groupRow}>
                <strong>Group</strong>
                <span>Repository access</span>
                <span>Runners</span>
                <span>Public repos</span>
              </div>
              {groups.map((g) => (
                <div className={r.groupRow} key={g.id}>
                  <Link href={base + '/runner-groups/' + g.id}>{g.name}</Link>
                  <span>
                    {g.visibility === 'all'
                      ? 'All repositories'
                      : g.repositories.length + ' selected repositories'}
                  </span>
                  <span>{runners.filter((x) => x.group === g.id).length}</span>
                  <span>
                    {g.allow_public_repositories ? 'Allowed' : 'Excluded'}
                  </span>
                </div>
              ))}
            </div>
          </>
        )
      ) : (
        <>
          <h1>{repo ? 'Runners that can take this repo’s jobs' : 'Runners'}</h1>
          <div className={r.toolbar}>
            <input
              aria-label="Search runners"
              placeholder="Search runners by name or label"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <details className={r.newRunner}>
              <summary className={s.primary}>
                New {repo ? 'repo ' : ''}runner ⌄
              </summary>
              <div>
                {[
                  ['macos', 'macOS'],
                  ['linux', 'Linux'],
                  ['windows', 'Windows'],
                ].map(([key, label]) => (
                  <Link key={key} href={base + '/runners/new/' + key}>
                    {label}
                  </Link>
                ))}
              </div>
            </details>
          </div>
          <div className={r.table}>
            <div className={r.tableHead}>
              <span>
                {eligible.length} {eligible.length === 1 ? 'runner' : 'runners'}
              </span>
              <span>Status</span>
            </div>
            {eligible.map(row)}
            {loaded && !eligible.length && (
              <div className={s.row}>No eligible runners</div>
            )}
          </div>
          {shown
            .filter((x) => x.eligible === false)
            .map((x) => (
              <p className={s.dim} key={x.gild_id}>
                {x.name} · from{' '}
                <Link href={ownerBase + '/runners'}>@{owner}</Link> ·{' '}
                {x.group_name}: {x.ineligible_reason}.
              </p>
            ))}
        </>
      )}
      {edit && (
        <dialog open className={s.dialog}>
          <h2>
            {edit.mode === 'group' ? 'Move to group' : 'Edit labels'} ·{' '}
            {edit.runner.name}
          </h2>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const f = new FormData(e.currentTarget)
              void perform(async () => {
                await runnerCall(
                  api + '/runners/' + edit.runner.gild_id,
                  'PATCH',
                  edit.mode === 'group'
                    ? { group: f.get('group') }
                    : {
                        labels: String(f.get('labels'))
                          .split(',')
                          .map((x) => x.trim())
                          .filter(Boolean),
                      },
                )
                setEdit(null)
              })
            }}
          >
            {edit.mode === 'group' ? (
              <label>
                Runner group
                <select name="group" defaultValue={edit.runner.group}>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                Labels
                <input
                  name="labels"
                  defaultValue={edit.runner.labels
                    .map((x) => x.name)
                    .filter(
                      (x) =>
                        ![
                          'self-hosted',
                          'macos',
                          'linux',
                          'windows',
                          'win32',
                          'x64',
                          'arm64',
                        ].includes(x),
                    )
                    .join(', ')}
                />
              </label>
            )}
            <div className={s.dialogActions}>
              <button type="button" onClick={() => setEdit(null)}>
                Cancel
              </button>
              <button>Save</button>
            </div>
          </form>
        </dialog>
      )}
      {newGroup && (
        <dialog open className={s.dialog}>
          <h2>New runner group</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const f = new FormData(e.currentTarget)
              void perform(async () => {
                await runnerCall(api + '/runner-groups', 'POST', {
                  name: f.get('name'),
                })
                setNewGroup(false)
              })
            }}
          >
            <label>
              Name
              <input name="name" required maxLength={64} />
            </label>
            <div className={s.dialogActions}>
              <button type="button" onClick={() => setNewGroup(false)}>
                Cancel
              </button>
              <button>Create group</button>
            </div>
          </form>
        </dialog>
      )}
    </>
  )
}
