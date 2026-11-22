// Smoke test for the GavaConnect sandbox with KRA's published sample data:
// ID -> PIN, obligations, NIL return, TCC. Refuses to run against production.
//   npm run kra-sandbox
import {
  applyForTcc,
  fetchObligations,
  fileNilReturn,
  kraIsSandbox,
  lookupPinById,
  NIL_OBLIGATION,
} from '../src/kra/gavaconnect.js'

if (!kraIsSandbox()) {
  console.error('KRA_API_BASE is not the sandbox (https://sbx.kra.go.ke); refusing to file test returns.')
  process.exit(1)
}

const step = async (name: string, fn: () => Promise<unknown>) => {
  try {
    console.log(`${name}:`, JSON.stringify(await fn()))
  } catch (err) {
    console.log(`${name}: ERROR`, err instanceof Error ? err.message : err)
  }
}

await step('PIN by ID (41789723)', () => lookupPinById('41789723'))
await step('Obligations (A744610021G)', () => fetchObligations('A744610021G'))
await step('NIL return (A521040203F, 2016)', () =>
  fileNilReturn({ pin: 'A521040203F', obligationCode: NIL_OBLIGATION.incomeTaxResidentIndividual, year: 2016 })
)
await step('TCC (A948312567Q)', () => applyForTcc('A948312567Q', 'Job Application'))
