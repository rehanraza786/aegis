/** Sample AEGIS extension (tool hook): exposes the todos table as an MCP tool. */
export function register({ tool, z, withDb }) {
  tool("todos", "List TODO/FIXME markers across the workspace (from the todo sample extension).",
    { limit: z.number().int().optional() },
    ({ limit }) => withDb((d) => {
      if (!d.prepare("SELECT name FROM sqlite_master WHERE name='todos'").get()) return "todo extension pass hasn't run, reindex.";
      return d.prepare(`SELECT f.path, t.line, t.text FROM todos t JOIN files f ON f.id=t.file_id LIMIT ?`)
        .all(Math.min(limit ?? 50, 200));
    }));
}
