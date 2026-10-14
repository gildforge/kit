// Shared with the browser without importing server queue/event code.
export const runnerStatus = (
  runner: { job: number | null; lastSeen: number },
  now = Date.now(),
) =>
  runner.job ? 'Busy' : now - runner.lastSeen < 120000 ? 'Online' : 'Offline'
