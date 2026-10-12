/**
 * Which conversation has an agent run genuinely in flight, for the
 * in-project Design system tab's generation affordances.
 *
 * Only a real run counts: a pending transcript read, an unresolved billing
 * principal or read-only authority does not. The transcript counts only when
 * it was loaded for the active conversation.
 */

export interface DesignSystemRunMessage<S = string> {
  role: string;
  runStatus?: S;
}

/**
 * The conversation whose run is in flight right now, or null.
 *
 * `messages` is only trusted when it was loaded for `activeConversationId`:
 * on a route switch the active conversation changes before the old
 * transcript is cleared, and that stale transcript's run must not count.
 */
export function activeDesignSystemRunConversationId<S>(input: {
  activeConversationId: string | null;
  messagesConversationId: string | null;
  messages: readonly DesignSystemRunMessage<S>[];
  streamingConversationId: string | null;
  streaming: boolean;
  isActiveRunStatus: (status: S | undefined) => boolean;
}): string | null {
  const conversationId = input.activeConversationId;
  if (!conversationId) return null;
  if (input.streaming && input.streamingConversationId === conversationId) return conversationId;
  if (input.messagesConversationId !== conversationId) return null;
  return input.messages.some(
    (message) => message.role === 'assistant' && input.isActiveRunStatus(message.runStatus),
  )
    ? conversationId
    : null;
}
