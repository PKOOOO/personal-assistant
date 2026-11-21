// Registry of chat channel adapters, by platform name.
import type { Platform } from '../db/schema.js'
import { linqChannel } from '../linq/channel.js'
import { telegramChannel } from '../telegram/channel.js'
import { whatsappChannel } from '../whatsapp/channel.js'
import type { Channel } from './types.js'

const channels: Record<Platform, Channel> = {
  telegram: telegramChannel,
  imessage: linqChannel,
  whatsapp: whatsappChannel,
}

export function getChannel(platform: Platform): Channel {
  const channel = channels[platform]
  if (!channel) throw new Error(`Unknown channel: ${platform}`)
  return channel
}
