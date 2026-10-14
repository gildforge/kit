import type { MessageBatch, Queue } from '@cloudflare/workers-types'
import { hubFrom, type EventBindings } from './binding.js'
export interface DeliveryMessage { delivery: string }
export async function consumeWebhooks(batch: MessageBatch<DeliveryMessage>, env: EventBindings & {WEBHOOKS?: Queue<DeliveryMessage>}) {
  const hub = hubFrom(env)
  await Promise.all(batch.messages.map(async message => {
    try {
      if (batch.queue === 'gild-webhooks-dead') {
        await hub.deadLetter(message.body.delivery)
        message.ack()
        return
      }
      const result = await hub.attempt(message.body.delivery)
      if ('defer' in result && result.defer) {
        if (!env.WEBHOOKS) throw Error('WEBHOOKS binding is required')
        // New delayed message, then ack; lease contention consumes no retries.
        await env.WEBHOOKS.send(message.body, {delaySeconds: result.delaySeconds})
        message.ack()
      } else if (result.retry) message.retry({delaySeconds: result.delaySeconds})
      else message.ack()
    } catch { message.retry({delaySeconds: 30}) }
  }))
}
