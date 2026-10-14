import type { SQL } from '../../engine/repo-index-store.js'
import type { RunStore, Run, StoredJob } from '../actions/store.js'
import { EventOutbox } from '../../engine/events/outbox.js'
import { common, context } from './payloads.js'
import { jobShape, runShape } from '../api/actions.js'
export function actionEventSchema(sql: SQL) {
  sql.exec(`CREATE TABLE IF NOT EXISTS action_emissions(id TEXT PRIMARY KEY,kind TEXT,native TEXT,done INTEGER DEFAULT 0);
  CREATE TRIGGER IF NOT EXISTS action_run_event_insert AFTER INSERT ON action_runs BEGIN
    INSERT OR IGNORE INTO action_emissions(id,kind,native) VALUES ('run:'||NEW.id||':'||NEW.status,'run',json_object('id',NEW.id,'event',json(NEW.event),'workflow',json(NEW.workflow),'status',NEW.status,'created',NEW.created,'started',NEW.started,'finished',NEW.finished,'reason',NEW.reason));
  END;
  CREATE TRIGGER IF NOT EXISTS action_run_event_update AFTER UPDATE OF status ON action_runs WHEN OLD.status!=NEW.status BEGIN
    INSERT OR IGNORE INTO action_emissions(id,kind,native) VALUES ('run:'||NEW.id||':'||NEW.status,'run',json_object('id',NEW.id,'event',json(NEW.event),'workflow',json(NEW.workflow),'status',NEW.status,'created',NEW.created,'started',NEW.started,'finished',NEW.finished,'reason',NEW.reason));
  END;
  CREATE TRIGGER IF NOT EXISTS action_job_event_insert AFTER INSERT ON action_jobs BEGIN
    INSERT OR IGNORE INTO action_emissions(id,kind,native) VALUES ('job:'||NEW.id||':'||NEW.status,'job',json_object('id',NEW.id,'run',NEW.run,'spec',json(NEW.spec),'status',NEW.status,'runner',NEW.runner,'runnerName',NEW.runnerName,'started',NEW.started,'finished',NEW.finished,'deadline',NEW.deadline,'reason',NEW.reason));
  END;
  CREATE TRIGGER IF NOT EXISTS action_job_event_update AFTER UPDATE OF status ON action_jobs WHEN OLD.status!=NEW.status BEGIN
    INSERT OR IGNORE INTO action_emissions(id,kind,native) VALUES ('job:'||NEW.id||':'||NEW.status,'job',json_object('id',NEW.id,'run',NEW.run,'spec',json(NEW.spec),'status',NEW.status,'runner',NEW.runner,'runnerName',NEW.runnerName,'started',NEW.started,'finished',NEW.finished,'deadline',NEW.deadline,'reason',NEW.reason));
  END;`)
}
export function captureActionEvents(
  runs: RunStore,
  sql: SQL,
  outbox: EventOutbox,
  repository: string,
) {
  if (repository === 'null/null') return
  for (const row of [
    ...sql.exec<{ id: string; kind: string; native: string }>(
      'SELECT id,kind,native FROM action_emissions WHERE done=0 LIMIT 100',
    ),
  ]) {
    const c = context(repository),
      native = JSON.parse(row.native) as Run | Omit<StoredJob, 'lease'>,
      isRun = row.kind === 'run',
      status = native.status,
      action =
        status === 'queued'
          ? 'queued'
          : status === 'running'
            ? 'in_progress'
            : 'completed'
    const run = isRun ? (native as Run) : runs.run((native as StoredJob).run)!
    const payload = isRun
      ? { action, workflow_run: runShape(c, run) }
      : {
          action,
          workflow_job: jobShape(
            run,
            native as StoredJob,
            action === 'completed' ? runs.steps(native.id) : [],
          ),
        }
    outbox.put({
      id: `actions:${repository}:${row.id}`,
      event: isRun ? 'workflow_run' : 'workflow_job',
      repository,
      payload: { ...common(repository, run.event.actor), ...payload },
    })
    sql.exec(
      'UPDATE action_emissions SET done=1,native=NULL WHERE id=?',
      row.id,
    )
  }
}
