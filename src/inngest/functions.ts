import { telegramLink } from './link.js'
import { telegramChat } from './telegram.js'

// Every Inngest function the app serves at /api/inngest.
export const functions = [telegramChat, telegramLink]
