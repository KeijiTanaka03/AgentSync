export interface ConversationPane {
  key: number
  id: string | null
  initialScrollTop?: number
}

/** Pane keys represent view identity, even when both show the same conversation. */
export function selectConversation(panes: ConversationPane[], key: number, id: string | null): ConversationPane[] {
  return panes.map((pane) => pane.key === key ? { ...pane, id, initialScrollTop: undefined } : pane)
}

export function splitPane(panes: ConversationPane[], key: number, initialScrollTop: number): ConversationPane[] {
  if (panes.length !== 1) return panes
  return [...panes, { key, id: panes[0]!.id, initialScrollTop }]
}

export function keepPane(panes: ConversationPane[], selected: number): ConversationPane[] {
  return panes.filter((pane) => pane.key === selected)
}
