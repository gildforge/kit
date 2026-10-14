/** Read every retained chunk, including logs beyond the first RPC page. */
export async function jobLogs(
  queue: {
    logs(
      job: number,
      step: number,
      after: number,
    ): Promise<{ seq: number; text: string }[]>
  },
  job: { id: number; steps: { position: number }[] },
) {
  const logs: { job: number; step: number; seq: number; text: string }[] = []
  for (const step of job.steps) {
    let after = -1
    while (true) {
      const chunks = await queue.logs(job.id, step.position, after)
      if (!chunks.length) break
      logs.push(
        ...chunks.map((chunk) => ({
          job: job.id,
          step: step.position,
          ...chunk,
        })),
      )
      after = chunks[chunks.length - 1].seq
    }
  }
  return logs
}
