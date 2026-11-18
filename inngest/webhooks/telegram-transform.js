// Inngest webhook transform for Telegram Bot API updates.
//
// Paste this function into the Telegram webhook's "Transform" editor in the
// Inngest dashboard (Manage -> Webhooks). It runs on Inngest's servers, not in
// this app; it lives in the repo so the code is versioned.
//
// - id: Telegram resends an update until it gets a 2xx; reusing update_id as
//   the event id makes Inngest drop those duplicates (24h dedupe window).
// - secretToken: the X-Telegram-Bot-Api-Secret-Token header, checked against
//   TELEGRAM_WEBHOOK_SECRET by the telegram-chat function.
function transform(evt, headers = {}, queryParams = {}) {
  return {
    id: `telegram-update-${evt.update_id}`,
    name: 'telegram/update.received',
    data: {
      update: evt,
      secretToken: headers['X-Telegram-Bot-Api-Secret-Token'] || null,
    },
  }
}
