"""Sample AEGIS extension (Python pass hook): TODO/FIXME scan into a todos table."""
import re


def run(ctx):
    con = ctx["con"]
    con.execute("CREATE TABLE IF NOT EXISTS todos(file_id INTEGER, line INTEGER, text TEXT)")
    con.execute("DELETE FROM todos")
    for rel in ctx["tracked"]:
        if not re.search(r"\.(java|kt|ts|tsx|js|jsx|py|md)$", rel):
            continue
        text = ctx["read_text"](rel)
        fid = ctx["id_by_path"].get(rel)
        if not text or not fid:
            continue
        for n, line in enumerate(text.splitlines(), 1):
            m = re.search(r"(?://|#|\*)\s*(TODO|FIXME)[:\s](.{0,120})", line)
            if m:
                con.execute("INSERT INTO todos(file_id, line, text) VALUES(?,?,?)",
                            (fid, n, f"{m.group(1)}: {m.group(2).strip()}"))
