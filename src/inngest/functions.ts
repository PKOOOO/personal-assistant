import { chat } from './chat.js'
import { linkAccountFn } from './link.js'

// Every Inngest function the app serves at /api/inngest.
export const functions = [chat, linkAccountFn]
