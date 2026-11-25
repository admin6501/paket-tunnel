export async function deliverToInbox(env, method, params) {
  if (method === 'deleteMessage' || method === 'editMessageReplyMarkup' ||
      method === 'answerCallbackQuery') return { ok: true };
  if (method !== 'sendMessage' || !Number.isSafeInteger(Number(params.chat_id))) {
    return { ok: false, description: 'Unsupported store delivery' };
  }
  const saved = await env.DB.prepare(`
    INSERT INTO store_inbox(user_id,html,created_at)
    SELECT id,?,? FROM store_accounts WHERE id=?
  `).bind(String(params.text || '').slice(0, 16_000), Date.now(), Number(params.chat_id)).run();
  return { ok: Boolean(saved.meta.changes), result: { message_id: saved.meta.last_row_id } };
}
