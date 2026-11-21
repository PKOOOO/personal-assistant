import { chat } from './chat.js'
import { mpesaPayment } from './payment.js'

// Every Inngest function the app serves at /api/inngest.
export const functions = [chat, mpesaPayment]
