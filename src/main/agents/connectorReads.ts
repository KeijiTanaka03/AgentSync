/**
 * Connector (MCP) tools known to only read: the ones a read-only turn may use, for Claude and Codex alike.
 * Each list is tied to the provider it was checked against (search, fetch and read, with no write) and to
 * exact tool names. A name that sounds like reading, a server's own read-only hint, or a server that is
 * merely called the same, is not enough: anything else is refused on such a turn.
 */
const NOTION_READS = [
  'search', 'fetch', 'get-comments', 'get-users', 'get-teams', 'get-groups', 'get-self', 'query-data-sources', 'query-meeting-notes',
  'list-recent-pages', 'list-favorite-pages', 'list-private-pages', 'list-shared-pages', 'list-page-backlinks', 'get-version-changes',
  'view-version', 'memory-search',
].map((t) => `notion-${t}`)
const DRIVE_READS = ['search_files', 'read_file_content', 'get_file_metadata', 'get_file_permissions', 'list_recent_files', 'list_file_revisions', 'list_shared_drives', 'get_shared_drive_metadata']

/** claude.ai connectors, as Claude Code names them. They are set up in the claude.ai account, not locally. */
const CLAUDE_AI: Record<string, readonly string[]> = {
  claude_ai_Notion: NOTION_READS,
  claude_ai_Google_Drive: DRIVE_READS,
}

/** Codex connectors by the origin of the endpoint the thread really uses: the official servers only. */
const BY_ORIGIN: Record<string, readonly string[]> = {
  'https://mcp.notion.com': NOTION_READS,
}

/**
 * `mcp__claude_ai_Notion__notion-search`: a verified read of a claude.ai connector. `connectors` is where the
 * running Claude Code says each of its connectors comes from; unless it says claude.ai, nothing is trusted.
 */
export function isVerifiedClaudeRead(name: string, connectors: ReadonlyMap<string, string>): boolean {
  const match = /^mcp__(.+?)__(.+)$/.exec(name)
  if (!match) return false
  const [, server, tool] = match as unknown as [string, string, string]
  if (connectors.get(server) !== 'claudeai') return false
  return CLAUDE_AI[server]?.includes(tool) ?? false
}

/** A Codex connector's tool: verified when the thread's connection to it goes to a known origin. */
export function isVerifiedCodexRead(origin: string | null | undefined, tool: string): boolean {
  if (!origin) return false
  return BY_ORIGIN[origin.replace(/\/+$/, '')]?.includes(tool) ?? false
}
