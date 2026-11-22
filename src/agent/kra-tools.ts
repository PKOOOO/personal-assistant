// KRA tools for trying the nil-return flow in the chat (2026-11-22).
//
// SANDBOX ONLY: they're added to the agent only while KRA_API_BASE is KRA's
// sandbox (test taxpayers, nothing is really filed), so the flow can be tried
// in Telegram/WhatsApp before the real build (Inngest function, payment,
// consent record; see AGENTS.md "Plan: KRA nil returns"). Never point these at
// production: real filing must go through the paid, consented flow.
//
// ID numbers, PINs and names are personal data: they go to KRA and back to the
// user, never into logs.
import { z } from 'zod'
import { defineTool, durable } from './tool.js'
import {
  applyForTcc,
  fetchObligations,
  fileNilReturn,
  kraEnabled,
  kraIsSandbox,
  lookupPinById,
  NIL_OBLIGATION,
} from '../kra/gavaconnect.js'

export const kraTestToolsEnabled = () =>
  kraIsSandbox() && (['PIN_BY_ID', 'OBLIGATIONS', 'NIL_RETURN', 'TCC'] as const).some(kraEnabled)

export const KRA_TEST_PROMPT = `

# KRA (test mode)
You can look up KRA PINs, check tax obligations, file NIL income tax returns and apply for Tax Compliance Certificates, but ONLY on KRA's test system: nothing is really filed. Always say clearly that this is a test with KRA's test data. Test IDs and PINs: ID 41789723 (PIN A744610021G), PINs A521040203F, A948312567Q. If the user gives their real ID or PIN, explain the test system won't find real people yet.
Follow this order for a nil return:
1. Ask whether they had ANY income in that year (job/PAYE, business, rent, pension). If yes, a nil return is wrong for them: explain they must file a normal return with their P9 on iTax, and stop.
2. Get their ID number and use kra_lookup_pin; ask them to confirm the name ("Is this you, <NAME>?").
3. Use kra_check_obligations; they need "Income Tax - Resident Individual".
4. Ask for explicit consent: "I authorise Holler to file a NIL income tax return for <year> on my behalf. Reply YES." Only after a clear yes, use kra_file_nil_return with confirmed=true.
5. Report KRA's answer exactly: the acknowledgement number if filed, or KRA's message if rejected (e.g. already filed, or the period isn't open yet).
TCC: confirm the name first, then kra_apply_tcc with their reason (e.g. "Job Application"). Never present KRA results as tax advice.`

const fail = (r: { code?: string; message: string }) => `KRA rejected it${r.code ? ` (code ${r.code})` : ''}: ${r.message}`

export function kraTestTools() {
  const lookup = defineTool({
    name: 'kra_lookup_pin',
    description: "Look up a Kenyan taxpayer's KRA PIN and registered name from their national ID number (KRA test system).",
    parameters: z.object({ id_number: z.string().describe('National ID number, digits only.') }),
    handler: async ({ id_number }, { step }) =>
      durable(step, 'kra_lookup_pin', async () => {
        const r = await lookupPinById(id_number.replace(/\D/g, ''))
        return r.ok ? `PIN ${r.pin}, registered name ${r.name || 'unknown'} (KRA test system).` : fail(r)
      }),
  })

  const obligations = defineTool({
    name: 'kra_check_obligations',
    description: "List a KRA PIN's registered tax obligations (KRA test system).",
    parameters: z.object({ pin: z.string().describe('KRA PIN, e.g. A744610021G.') }),
    handler: async ({ pin }, { step }) =>
      durable(step, 'kra_check_obligations', async () => {
        const r = await fetchObligations(pin)
        return r.ok ? `Obligations: ${r.obligations.map((o) => o.name).join('; ') || 'none'}.` : fail(r)
      }),
  })

  const nil = defineTool({
    name: 'kra_file_nil_return',
    description:
      'File a NIL income tax return (resident individual) for one year on KRA\'s test system. Only after the user said they had no income that year, confirmed their name, and replied YES to the consent question.',
    parameters: z.object({
      pin: z.string().describe('KRA PIN.'),
      year: z.number().int().min(2000).max(2100).describe('Income year, e.g. 2025.'),
      confirmed: z.boolean().describe('true only if the user explicitly consented in this chat.'),
    }),
    handler: async ({ pin, year, confirmed }, { step }) =>
      durable(step, 'kra_file_nil_return', async () => {
        if (!confirmed) return 'Not filed: ask the user for explicit consent first.'
        if (!kraIsSandbox()) return 'Error: filing in chat is only enabled on the KRA test system.'
        const r = await fileNilReturn({ pin, obligationCode: NIL_OBLIGATION.incomeTaxResidentIndividual, year })
        return r.ok ? `Filed (KRA test system). Acknowledgement number ${r.ackNumber}. ${r.message}` : fail(r)
      }),
  })

  const tcc = defineTool({
    name: 'kra_apply_tcc',
    description: 'Apply for a KRA Tax Compliance Certificate for a PIN (KRA test system). Only after the user confirmed their name.',
    parameters: z.object({
      pin: z.string().describe('KRA PIN.'),
      reason: z.string().describe('Short reason, e.g. "Job Application".'),
    }),
    handler: async ({ pin, reason }, { step }) =>
      durable(step, 'kra_apply_tcc', async () => {
        if (!kraIsSandbox()) return 'Error: TCC applications in chat are only enabled on the KRA test system.'
        const r = await applyForTcc(pin, reason)
        return r.ok ? `TCC issued (KRA test system): ${r.tccNumber}.` : fail(r)
      }),
  })

  return [
    ...(kraEnabled('PIN_BY_ID') ? [lookup] : []),
    ...(kraEnabled('OBLIGATIONS') ? [obligations] : []),
    ...(kraEnabled('NIL_RETURN') ? [nil] : []),
    ...(kraEnabled('TCC') ? [tcc] : []),
  ]
}
