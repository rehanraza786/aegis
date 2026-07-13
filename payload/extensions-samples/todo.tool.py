"""Sample AEGIS extension (Python tool hook): expose todos as an MCP tool."""


def register(mcp, db):
    @mcp.tool()
    def todos(limit: int = 50) -> str:
        """List TODO/FIXME markers across the workspace (todo sample extension)."""
        con = db()
        if not con.execute("SELECT name FROM sqlite_master WHERE name='todos'").fetchone():
            return "todo extension pass hasn't run, reindex."
        rows = con.execute("SELECT f.path, t.line, t.text FROM todos t JOIN files f ON f.id=t.file_id LIMIT ?",
                           (min(limit, 200),)).fetchall()
        return "\n".join(f"{r[0]}:{r[1]} {r[2]}" for r in rows) or "No TODOs found."
