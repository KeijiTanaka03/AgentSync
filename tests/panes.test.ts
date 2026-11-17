import { describe, expect, it } from 'vitest'
import { keepPane, selectConversation, splitPane } from '../src/renderer/src/panes'

describe('conversation panes', () => {
  it('opens the same thread in a distinct view with its initial scroll position', () => {
    const original = [{ key: 0, id: 'thread-a' }]
    const panes = splitPane(original, 1, 240)
    expect(panes).toEqual([original[0], { key: 1, id: 'thread-a', initialScrollTop: 240 }])
    expect(original).toHaveLength(1)
    expect(splitPane(panes, 2, 0)).toBe(panes)
  })

  it('switches only the chosen view, including when both show the same thread', () => {
    const panes = splitPane([{ key: 0, id: 'thread-a' }], 1, 240)
    const switched = selectConversation(panes, 1, 'thread-b')
    expect(switched[0]).toBe(panes[0])
    expect(switched[1]).toEqual({ key: 1, id: 'thread-b', initialScrollTop: undefined })
  })

  it('keeps the selected right view identity when returning to one view', () => {
    const panes = splitPane([{ key: 0, id: 'thread-a' }], 1, 240)
    const kept = keepPane(panes, 1)
    expect(kept).toEqual([panes[1]])
    expect(kept[0]).toBe(panes[1])
    const reopened = splitPane(kept, 2, 600)
    expect(reopened[0]).toBe(panes[1])
    expect(reopened[1]).toEqual({ key: 2, id: 'thread-a', initialScrollTop: 600 })
  })

  it('ignores a completed async creation targeted at a pane that has closed', () => {
    const panes = keepPane(splitPane([{ key: 0, id: 'thread-a' }], 1, 0), 0)
    expect(selectConversation(panes, 1, 'new-thread')).toEqual(panes)
  })
})
