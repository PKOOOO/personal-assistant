// Sentry for Inngest function runs: one trace per run, a span per request and
// per executed step, and function failures reported as issues.
//
// Replaces @inngest/middleware-sentry 1.0.0, which (a) continued its trace
// without a dynamic sampling context, so Sentry SDK v11 dropped every span of
// the run ("missing_dsc"), AI spans included, and (b) put the whole event
// (users' message text) on its span.
//
// - The trace id is derived from the run id, so all requests of a run (after
//   a retry, a wait) share one trace. Sampling is decided from that trace id,
//   so a run is sampled as a whole, at the configured tracesSampleRate.
// - No event or step data goes on spans: only function, event name and ids.
import * as Sentry from '@sentry/hono/node'
import { dynamicSamplingContextToSentryBaggageHeader, getDynamicSamplingContextFromClient } from '@sentry/core'
import { Middleware } from 'inngest'

type Span = ReturnType<typeof Sentry.startInactiveSpan>

export class SentryMiddleware extends Middleware.BaseMiddleware {
  readonly id = 'personal-assistant:sentry'

  #scope: Sentry.Scope | undefined
  #tags: Record<string, string> = {}
  #requestSpan: Span | undefined
  #stepSpans = new Map<string, Span>()
  #hasError = false

  override wrapRequest({ next, fn, runId }: Middleware.WrapRequestArgs) {
    // Registration and introspection requests have no function.
    const client = Sentry.getClient()
    if (!fn || !client) return next()

    const traceId = ulidToTraceId(runId)
    const rate = Number(client.getOptions().tracesSampleRate ?? 0)
    // Same decision on every request of the run: derived from the trace id.
    const sampleRand = parseInt(traceId.slice(-8), 16) / 0x1_0000_0000
    const sampled = sampleRand < rate
    const baggage = dynamicSamplingContextToSentryBaggageHeader({
      ...getDynamicSamplingContextFromClient(traceId, client),
      sampled: String(sampled),
      sample_rate: String(rate),
      sample_rand: sampleRand.toFixed(6),
    })
    const sentryTrace = `${traceId}-${traceId.slice(0, 16)}-${sampled ? 1 : 0}`

    return Sentry.startNewTrace(() =>
      Sentry.continueTrace({ sentryTrace, baggage }, () =>
        Sentry.withIsolationScope((scope) => {
          this.#scope = scope
          this.#tags = {
            'inngest.function.id': fn.id(this.client.id),
            'inngest.function.name': fn.name,
            'inngest.run.id': runId,
          }
          scope.setTags(this.#tags)
          scope.setTransactionName(`inngest:${fn.name}`)
          return Sentry.startSpanManual(
            { name: `inngest:${fn.name}`, op: 'function.inngest', attributes: this.#tags },
            async (span) => {
              this.#requestSpan = span
              try {
                return await next()
              } finally {
                if (!this.#hasError) span.setStatus({ code: 1 })
                for (const stepSpan of this.#stepSpans.values()) stepSpan.end()
                this.#stepSpans.clear()
                span.end()
                await Sentry.flush(2000)
              }
            }
          )
        })
      )
    )
  }

  override async wrapFunctionHandler({ next, ctx }: Middleware.WrapFunctionHandlerArgs) {
    const tags = { 'inngest.event.name': String(ctx.event.name), 'inngest.event.id': String(ctx.event.id ?? '') }
    Object.assign(this.#tags, tags)
    this.#scope?.setTags(tags)
    this.#requestSpan?.setAttributes(tags)
    return next()
  }

  // Only steps that run here (step.run, step.sendEvent), never memoized ones.
  override onStepStart({ stepInfo }: Middleware.OnStepStartArgs) {
    const name = stepInfo.options.name ?? stepInfo.options.id
    const span = Sentry.startInactiveSpan({
      name,
      op: 'function.inngest.step',
      parentSpan: this.#requestSpan,
      attributes: { ...this.#tags, 'inngest.step.name': name, 'inngest.step.type': String(stepInfo.stepType) },
    })
    this.#stepSpans.set(stepInfo.hashedId, span)
  }

  override onStepComplete({ stepInfo }: Middleware.OnStepCompleteArgs) {
    this.#endStep(stepInfo.hashedId, 1)
  }

  override onStepError({ stepInfo, isFinalAttempt }: Middleware.OnStepErrorArgs) {
    this.#hasError = true
    this.#endStep(stepInfo.hashedId, 2)
    this.#scope?.addBreadcrumb({
      category: 'inngest.step',
      message: stepInfo.options.name ?? stepInfo.options.id,
      data: { finalAttempt: isFinalAttempt },
      level: 'error',
    })
  }

  // Function failures become issues on the last attempt only (earlier ones are retried).
  override onRunError({ error, isFinalAttempt }: Middleware.OnRunErrorArgs) {
    this.#hasError = true
    this.#requestSpan?.setStatus({ code: 2, message: error.name })
    if (!isFinalAttempt) return
    const capture = () => Sentry.captureException(error, { tags: { ...this.#tags, 'inngest.error.source': 'run' } })
    if (this.#requestSpan) Sentry.withActiveSpan(this.#requestSpan, capture)
    else capture()
  }

  #endStep(hashedId: string, code: 1 | 2) {
    const span = this.#stepSpans.get(hashedId)
    if (!span) return
    span.setStatus({ code })
    span.end()
    this.#stepSpans.delete(hashedId)
  }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A run id (ULID, 26 Crockford base32 chars) as a 32-hex-char trace id. */
function ulidToTraceId(ulid: string) {
  const upper = ulid.toUpperCase()
  const bytes: number[] = []
  let buf = CROCKFORD.indexOf(upper[0]!) & 0x07
  let bits = 3
  for (let i = 1; i < upper.length; i++) {
    buf = (buf << 5) | CROCKFORD.indexOf(upper[i]!)
    bits += 5
    while (bits >= 8 && bytes.length < 16) {
      bits -= 8
      bytes.push((buf >>> bits) & 0xff)
      buf &= (1 << bits) - 1
    }
  }
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('').padEnd(32, '0')
}
