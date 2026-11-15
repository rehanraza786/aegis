"""DB topology extraction (Python edition; mirror of db.mjs).
Liquibase changelogs (XML/YAML/formatted SQL) -> table definitions;
Spring Boot code (JPA entities, Spring Data repos, @Query, JdbcTemplate) -> access sites."""
import re
from bisect import bisect_left

CHANGELOG_PATH_RE = re.compile(r"(changelog|migration|liquibase)", re.I)
CHANGELOG_CONTENT_RE = re.compile(r"databaseChangeLog|--\s*liquibase|<changeSet|changeSet:", re.I)
XML_CS_RE = re.compile(r'<changeSet[^>]*\bid\s*=\s*"([^"]+)"[^>]*\bauthor\s*=\s*"([^"]+)"')
SQL_CS_RE = re.compile(r"--\s*changeset\s+([\w.\-]+):([\w.\-]+)", re.I)
YAML_CS_RE = re.compile(r"-\s*changeSet:\s*[\s\S]{0,120}?id:\s*([\w.\-]+)[\s\S]{0,120}?author:\s*([\w.\-]+)")
XML_OPS = [
    (re.compile(r'<createTable[^>]*tableName\s*=\s*"([^"]+)"'), "create"),
    (re.compile(r'<addColumn[^>]*tableName\s*=\s*"([^"]+)"'), "alter"),
    (re.compile(r'<dropTable[^>]*tableName\s*=\s*"([^"]+)"'), "drop"),
    (re.compile(r'<renameTable[^>]*newTableName\s*=\s*"([^"]+)"'), "create"),
    (re.compile(r'<renameTable[^>]*oldTableName\s*=\s*"([^"]+)"'), "drop"),
    (re.compile(r'<addForeignKeyConstraint[^>]*baseTableName\s*=\s*"([^"]+)"'), "alter"),
    (re.compile(r'<(?:addUniqueConstraint|createIndex|addNotNullConstraint|modifyDataType|addPrimaryKey)[^>]*tableName\s*=\s*"([^"]+)"'), "alter"),
]
YAML_OPS = [
    (re.compile(r"(?:createTable|renameTable):\s*[\s\S]{0,200}?(?:tableName|newTableName):\s*([\w\"']+)"), "create"),
    (re.compile(r"(?:addColumn|addForeignKeyConstraint|createIndex|addUniqueConstraint|modifyDataType|addPrimaryKey):\s*[\s\S]{0,200}?(?:tableName|baseTableName):\s*([\w\"']+)"), "alter"),
    (re.compile(r"dropTable:\s*[\s\S]{0,200}?tableName:\s*([\w\"']+)"), "drop"),
]
# One name part: [bracketed] (SQL Server), "quoted", `ticked`, or bare. Bare parts
# may start with # or @ so temp tables and table variables are CONSUMED (and then
# rejected by _is_real_object) instead of half-matching. Up to db.schema.object.
ID_PART = r'(?:\[[^\]\r\n]+\]|"[^"\r\n]+"|\x60[^\x60\r\n]+\x60|[A-Za-z_#@][\w$#@]*)'
QNAME = ID_PART + r'(?:\.' + ID_PART + r'){0,2}'
SQL_DDL_RE = re.compile(r'\b(CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+(' + QNAME + ')', re.I)
# A .sql file that defines schema objects is a schema source even outside a
# changelog/migration folder: SSDT projects, db/procs/*.sql, schema.sql.
SQL_OBJECT_FILE_RE = re.compile(r"^\s*(?:CREATE(?:\s+OR\s+(?:ALTER|REPLACE))?|ALTER)\s+(?:PROC(?:EDURE)?|VIEW|FUNCTION|TRIGGER|TABLE)\b", re.I | re.M)
ANN_CLASS_RE = re.compile(r"((?:@\w+(?:\s*\([^)]*\))?\s*)+)(?:public\s+|final\s+|abstract\s+)*class\s+(\w+)")
TABLE_NAME_RE = re.compile(r'@Table\s*\(\s*(?:[^)]*?name\s*=\s*)?"([^"]+)"')
FIELD_RE = re.compile(r"(?:private|protected)\s+(?!static\s+final)(?:final\s+)?([\w.$]+(?:\s*<[^;=]*?>)?(?:\[\])?)\s+(\w+)\s*(?:=|;)")
REPO_RE = re.compile(r"interface\s+(\w+)\s+extends\s+(?:\w+\.)*(?:Jpa|Crud|Paging(?:AndSorting)?|List(?:Crud|Paging)?|Reactive\w*)Repository\s*<\s*(\w+)")
QUERY_ANN_RE = re.compile(r'@Query\s*\(\s*(?:value\s*=\s*)?"([\s\S]*?)"\s*(?:,\s*nativeQuery\s*=\s*(true))?\s*\)')
JDBC_RE = re.compile(r'(?:jdbc\w*|template|namedParameterJdbcTemplate)\s*\.\s*(query\w*|update|execute|batchUpdate)\s*\(\s*("(?:[^"\\]|\\.)*"|\w+)', re.I)
SQL_TABLES_RE = re.compile(r'\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO)\s+(' + QNAME + ')', re.I)
JPQL_ENTITY_RE = re.compile(r"\b(?:FROM|JOIN|UPDATE|DELETE\s+FROM)\s+(\w+)", re.I)
SQL_NOISE = {"select", "dual", "values", "set", "where", "on"}


def is_changelog(relpath, text):
    if not re.search(r"\.(xml|ya?ml|sql)$", relpath):
        return False
    if CHANGELOG_PATH_RE.search(relpath):
        return bool(CHANGELOG_CONTENT_RE.search(text)) or relpath.endswith(".sql")
    if relpath.endswith(".sql") and SQL_OBJECT_FILE_RE.search(text):
        return True
    return bool(re.search(r"databaseChangeLog|--\s*liquibase formatted sql", text, re.I))


def _split_name(raw):
    """"[dbo].[Orders]" -> {name: "orders", schema: "dbo", db: None}. Parity: splitName (Node)."""
    parts = [re.sub(r'^[\["`]|[\]"`]$', "", p).lower()
             for p in re.findall(r'\[[^\]]+\]|"[^"]+"|`[^`]+`|[^.\s]+', raw)]
    return {"name": parts[-1] if parts else "", "schema": parts[-2] if len(parts) > 1 else None,
            "db": parts[0] if len(parts) > 2 else None}


def _is_real_object(n):
    """Real schema objects only: no #temp, no @variables, no catalog views."""
    return bool(n["name"]) and bool(re.match(r"[a-z_]", n["name"])) \
        and n["schema"] not in ("sys", "information_schema")


# ---------- SQL Server routines: procedures, views, functions, triggers ----------
# Procedures live in their own namespace (`proc:<name>`) because code EXECs them
# rather than selecting from them; views and functions share the table namespace
# because code reads them exactly like tables. Triggers get no definition row:
# their table gets a `trigger` access row and their body's writes are attributed
# to them. Parity: the routine section of db.mjs.
ROUTINE_HDR_RE = re.compile(r"\b(CREATE(?:\s+OR\s+(?:ALTER|REPLACE))?|ALTER|DROP)\s+(PROC(?:EDURE)?|VIEW|FUNCTION|TRIGGER)\s+(?:IF\s+EXISTS\s+)?(" + QNAME + ")", re.I)
TRIGGER_ON_RE = re.compile(r"\s+ON\s+(" + QNAME + ")", re.I)
BATCH_END_RE = re.compile(r"^[ \t]*GO[ \t]*(?:--[^\n]*)?\r?$|--\s*changeset\b|</(?:sql|createProcedure|changeSet)>", re.I | re.M)
BODY_WRITE_RE = re.compile(r"\b(?:INSERT\s+(?:INTO\s+)?|UPDATE\s+(?:TOP\s*\([^)]*\)\s*)?|DELETE\s+(?:TOP\s*\([^)]*\)\s*)?(?:FROM\s+)?|MERGE\s+(?:TOP\s*\([^)]*\)\s*)?(?:INTO\s+)?|TRUNCATE\s+TABLE\s+)(" + QNAME + ")", re.I)
BODY_READ_RE = re.compile(r"\b(FROM|JOIN|USING|APPLY)\s+(" + QNAME + r")(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?", re.I)
BODY_EXEC_RE = re.compile(r"\bEXEC(?:UTE)?\s+(?:@\w+\s*=\s*)?(" + QNAME + ")", re.I)
CTE_RE = re.compile(r"(?:\bWITH|,)\s*([A-Za-z_]\w*)\s*(?:\([^()]*\)\s*)?AS\s*\(", re.I)
BODY_NOISE = {"select", "dual", "values", "set", "where", "on", "as", "of", "top", "table", "output",
              "statistics", "inserted", "deleted", "openjson", "openxml", "openquery", "openrowset",
              "opendatasource", "string_split"}
ALIAS_STOP = {"where", "on", "join", "inner", "left", "right", "full", "cross", "outer", "with", "group",
              "order", "set", "as", "union", "when", "then", "output", "option", "pivot", "unpivot", "apply",
              "values", "select", "into", "for", "having", "except", "intersect", "end", "begin", "if", "else",
              "return", "declare", "exec", "execute", "insert", "update", "delete", "merge", "go", "using",
              "not", "and", "or", "is"}
SYSTEM_PROCS = {"sp_executesql", "sp_rename", "sp_getapplock", "sp_releaseapplock", "sp_set_session_context",
                "sp_send_dbmail", "sp_addextendedproperty", "sp_updateextendedproperty", "sp_refreshview",
                "sp_recompile", "sp_help", "sp_helptext", "sp_who", "sp_who2", "sp_lock", "sp_configure",
                "sp_start_job"}
_COMMENT_RE = re.compile(r"('(?:[^']|'')*')|--[^\n]*|/\*[\s\S]*?\*/")


def _is_system_proc(n):
    return n["name"].startswith("xp_") or n["name"] in SYSTEM_PROCS or n["db"] in ("master", "msdb")


def _blank_sql_comments(text):
    """Blank -- and block comments with spaces (newlines kept), so offsets and line
    numbers still line up with the original text. 'strings' survive."""
    return _COMMENT_RE.sub(lambda m: m.group(0) if m.group(1) else re.sub(r"[^\n]", " ", m.group(0)), text)


def _parse_routines(relpath, text):
    src = _blank_sql_comments(text) if relpath.endswith(".sql") else text
    hdrs = list(ROUTINE_HDR_RE.finditer(src))
    if not hdrs:
        return src, []
    bounds = [m.start() for m in hdrs]
    bounds += [m.start() for m in BATCH_END_RE.finditer(src)]
    bounds += [m.start() for m in SQL_DDL_RE.finditer(src) if _is_real_object(_split_name(m.group(2)))]
    bounds.sort()
    routines = []
    for m in hdrs:
        n = _split_name(m.group(3))
        if not _is_real_object(n):
            continue
        kind = "proc" if m.group(2).upper().startswith("PROC") else m.group(2).lower()
        kw = m.group(1).upper()
        op = "create" if kw.startswith("CREATE") else "drop" if kw.startswith("DROP") else "alter"
        end = m.end()
        on = None
        if kind == "trigger" and op != "drop":
            t = TRIGGER_ON_RE.match(src, end, end + 300)
            tn = _split_name(t.group(1)) if t else None
            if tn and _is_real_object(tn) and tn["name"] not in ("database", "all"):
                on = tn["name"]
        nxt = next((b for b in bounds if b > m.start()), len(src))
        routines.append({"kind": kind, "name": n["name"], "op": op, "idx": m.start(),
                         "body_start": end, "body_end": end if op == "drop" else nxt, "on": on})
    return src, routines


def _routine_body_access(body):
    """Tables a routine body reads/writes and procedures it EXECs, with T-SQL aliases,
    CTE names and temp objects resolved away."""
    ctes = {m.group(1).lower() for m in CTE_RE.finditer(body)}
    alias = {}
    hits = []
    for m in BODY_READ_RE.finditer(body):
        n = _split_name(m.group(2))
        if m.group(3) and m.group(3).lower() not in ALIAS_STOP:
            alias[m.group(3).lower()] = n["name"]
        if m.group(1).upper() == "FROM" and re.search(r"\bDELETE\s+$", body[max(0, m.start() - 12):m.start()], re.I):
            continue
        hits.append((n, "read", m.start()))
    hits += [(_split_name(m.group(1)), "write", m.start()) for m in BODY_WRITE_RE.finditer(body)]
    hits += [(_split_name(m.group(1)), "exec", m.start()) for m in BODY_EXEC_RE.finditer(body)]
    out = []
    for n, mode, at in hits:
        if mode != "exec" and not n["schema"] and n["name"] in alias:
            n = dict(n, name=alias[n["name"]])
        if not _is_real_object(n) or n["name"] in ctes or n["name"] in BODY_NOISE:
            continue
        if mode == "exec":
            if not _is_system_proc(n):
                out.append({"table": "proc:" + n["name"], "kind": "proc", "mode": "exec", "at": at})
        else:
            out.append({"table": n["name"], "kind": "sql", "mode": mode, "at": at})
    return out


def extract_routine_access(relpath, text):
    """Access rows from routine bodies in one schema file: [{table, kind, mode, line, detail}]."""
    src, routines = _parse_routines(relpath, text)
    out, seen = [], set()

    def push(row):
        k = (row["table"], row["mode"], row["detail"])
        if k not in seen:
            seen.add(k)
            out.append(row)

    for r in routines:
        if r["op"] == "drop":
            continue
        detail = (f"trigger:{r['name']}" + (f" on {r['on']}" if r["on"] else "")) if r["kind"] == "trigger" \
            else f"{r['kind']}:{r['name']}"
        if r["kind"] == "trigger" and r["on"]:
            push({"table": r["on"], "kind": "trigger", "mode": "trigger", "line": _line(text, r["idx"]), "detail": detail})
        own = "proc:" + r["name"] if r["kind"] == "proc" else r["name"]
        for a in _routine_body_access(src[r["body_start"]:r["body_end"]]):
            if a["table"] == own:
                continue  # recursion / self-reference
            push({"table": a["table"], "kind": a["kind"], "mode": a["mode"],
                  "line": _line(text, r["body_start"] + a["at"]), "detail": detail})
    return out


# ---------- Procedure call sites in application code ----------
JDBC_CALL_RE = re.compile(r"\{\s*(?:\?\s*=\s*)?call\s+(" + QNAME + ")", re.I)
EXEC_LIT_RE = re.compile(r"^\s*EXEC(?:UTE)?\s+(?:@\w+\s*=\s*)?(" + QNAME + r")(?=\s*(?:$|[@?:;(,]))", re.I)
CALL_LIT_RE = re.compile(r"^\s*CALL\s+(" + QNAME + r")\s*\(", re.I)
STR_LIT_RE = re.compile(r'"((?:[^"\\\n]|\\.)*)"|\'((?:[^\'\\\n]|\\.)*)\'|`((?:[^`\\]|\\.)*)`')
_ARG = r'("(?:[^"\\]|\\.)*"|[A-Za-z_][\w.]*)'
PROC_APIS = [
    (re.compile(r"\.withProcedureName\s*\(\s*" + _ARG), "proc", "SimpleJdbcCall"),
    (re.compile(r"\.withFunctionName\s*\(\s*" + _ARG), "function", "SimpleJdbcCall"),
    (re.compile(r"\bcreateStoredProcedureQuery\s*\(\s*" + _ARG), "proc", "createStoredProcedureQuery"),
    (re.compile(r"@Procedure\s*\(\s*(?:(?:procedureName|value)\s*=\s*)?" + _ARG), "proc", "@Procedure"),
    (re.compile(r"@NamedStoredProcedureQuery\s*\([^@]{0,300}?\bprocedureName\s*=\s*" + _ARG), "proc", "@NamedStoredProcedureQuery"),
    (re.compile(r"(?:\bsuper|:\s*StoredProcedure)\s*\(\s*[\w.]+\s*,\s*" + _ARG), "proc", "StoredProcedure"),
    (re.compile(r"\bprepareCall\s*\(\s*([A-Za-z_][\w.]*)"), "sql", "prepareCall"),
    (re.compile(r"\.callproc\s*\(\s*([\"'])([\w.\[\]]+)\1"), "proc", "cursor.callproc"),
]
# @Procedure with no name binds the procedure named after the method
PROCEDURE_BARE_RE = re.compile(r"@Procedure(?:\s*\(\s*\))?\s+(?:[\w<>\[\],.?]+\s+)+?(\w+)\s*\(")
MSSQL_EXECUTE_RE = re.compile(r"\.execute\s*\(\s*([\"'`])([\w.\[\]]+)\1\s*[,)]")
# Cheap gate: does this file possibly call a stored procedure?
PROC_HINT_RE = re.compile(r"Procedure|prepareCall|\{\s*(?:\?\s*=\s*)?call\b|\bEXEC(?:UTE)?\s|callproc|\bCALL\s|['\"]mssql['\"]", re.I)


def _procs_in_sql(sql):
    """Procedure a SQL string invokes ({call x}, EXEC x, CALL x(...)), or None."""
    m = JDBC_CALL_RE.search(sql) or EXEC_LIT_RE.search(sql) or CALL_LIT_RE.search(sql)
    if not m:
        return None
    n = _split_name(m.group(1))
    return n if _is_real_object(n) and not _is_system_proc(n) else None


def _proc_call_sites(text, constants):
    out = []

    def resolve(arg):
        if arg.startswith('"'):
            return arg[1:-1]
        return constants.get(arg) or constants.get(arg.split(".")[-1])

    def add(n, obj_kind, idx, detail):
        if not n or not _is_real_object(n) or _is_system_proc(n):
            return
        out.append({"table": n["name"] if obj_kind == "function" else "proc:" + n["name"],
                    "kind": "proc", "mode": "exec", "line": _line(text, idx), "detail": detail})

    for m in STR_LIT_RE.finditer(text):
        s = m.group(1) if m.group(1) is not None else m.group(2) if m.group(2) is not None else (m.group(3) or "")
        n = _procs_in_sql(s) if len(s) < 400 else None
        if n:
            add(n, "proc", m.start(), "{call}" if re.match(r"\s*\{", s) else "CALL" if re.match(r"\s*CALL", s, re.I) else "EXEC")
    stored_proc_class = bool(re.search(r"extends\s+StoredProcedure\b|:\s*StoredProcedure\s*\(", text))
    for rx, obj_kind, detail in PROC_APIS:
        if detail == "StoredProcedure" and not stored_proc_class:
            continue
        for m in rx.finditer(text):
            if detail == "cursor.callproc":
                add(_split_name(m.group(2)), "proc", m.start(), detail)
                continue
            v = resolve(m.group(1))
            if not v:
                continue
            if obj_kind == "sql":  # constant SQL handed to prepareCall
                add(_procs_in_sql(v), "proc", m.start(), detail)
                continue
            add(_split_name(v), obj_kind, m.start(), detail)
    for m in PROCEDURE_BARE_RE.finditer(text):
        add(_split_name(m.group(1)), "proc", m.start(), "@Procedure(method name)")
    if re.search(r"(?:require\s*\(\s*|from\s+)['\"]mssql['\"]", text):
        for m in MSSQL_EXECUTE_RE.finditer(text):
            add(_split_name(m.group(2)), "proc", m.start(), "mssql request.execute")
    return out


# ---------- Migrations beyond Liquibase: Prisma, Rails, Alembic ----------
PRISMA_MODEL_RE = re.compile(r"\bmodel\s+(\w+)\s*\{([^}]*)\}")
PRISMA_MAP_RE = re.compile(r'@@map\s*\(\s*"([^"]+)"\s*\)')
# Liquibase's own view/procedure change types (a <createProcedure> body carries its
# CREATE PROCEDURE header, which the routine pass reads, so only drops need a rule)
XML_ROUTINE_OPS = [
    (re.compile(r'<createView[^>]*viewName\s*=\s*"([^"]+)"'), "create view", ""),
    (re.compile(r'<dropView[^>]*viewName\s*=\s*"([^"]+)"'), "drop view", ""),
    (re.compile(r'<dropProcedure[^>]*procedureName\s*=\s*"([^"]+)"'), "drop proc", "proc:"),
]
YAML_ROUTINE_OPS = [
    (re.compile(r"createView:\s*[\s\S]{0,200}?viewName:\s*([\w.\"'\[\]]+)"), "create view", ""),
    (re.compile(r"dropView:\s*[\s\S]{0,200}?viewName:\s*([\w.\"'\[\]]+)"), "drop view", ""),
    (re.compile(r"dropProcedure:\s*[\s\S]{0,200}?procedureName:\s*([\w.\"'\[\]]+)"), "drop proc", "proc:"),
]
RAILS_OPS = [
    (re.compile(r"\bcreate_table\s+[\"':]([\w]+)"), "create"),
    (re.compile(r"\b(?:add_column|change_column|add_index|remove_column|rename_column|add_reference)\s+[\"':]([\w]+)"), "alter"),
    (re.compile(r"\bdrop_table\s+[\"':]([\w]+)"), "drop"),
]
ALEMBIC_OPS = [
    (re.compile(r"\bop\.create_table\s*\(\s*[\"']([\w]+)"), "create"),
    (re.compile(r"\bop\.(?:add_column|alter_column|create_index|drop_column|create_foreign_key)\s*\(\s*[\"']([\w]+)"), "alter"),
    (re.compile(r"\bop\.drop_table\s*\(\s*[\"']([\w]+)"), "drop"),
]
ALEMBIC_REV_RE = re.compile(r"^revision\s*=\s*[\"']([\w]+)[\"']", re.M)


def is_schema_file(relpath, text):
    """Schema-defining files in non-Liquibase formats."""
    if relpath.endswith(".prisma"):
        return bool(re.search(r"\bmodel\s+\w+\s*\{", text))
    if relpath.endswith(".rb"):
        return bool(re.search(r"(^|/)db/(schema\.rb$|migrate/)", relpath)) \
            and bool(re.search(r"create_table|add_column|drop_table", text))
    if relpath.endswith(".py"):
        return bool(re.search(r"\bop\.(create_table|add_column|alter_column|drop_table)", text)) \
            and bool(re.search(r"(migrations?|alembic|versions)/", relpath))
    return False


def extract_schema_defs(relpath, text):
    """[{table, op, line, changeset}] from Prisma / Rails / Alembic files."""
    out = []
    stem = re.sub(r"\.\w+$", "", relpath.split("/")[-1])
    if relpath.endswith(".prisma"):
        for m in PRISMA_MODEL_RE.finditer(text):
            # Prisma tables are the model name verbatim unless @@map overrides
            mp = PRISMA_MAP_RE.search(m.group(2))
            table = (mp.group(1) if mp else m.group(1)).lower()
            out.append({"table": table, "op": "create", "line": _line(text, m.start()),
                        "changeset": f"prisma:{m.group(1)}"})
        return out
    opsets = RAILS_OPS if relpath.endswith(".rb") else ALEMBIC_OPS
    if relpath.endswith(".rb"):
        tag = "rails:schema" if relpath.endswith("schema.rb") else f"rails:{stem}"
    else:
        rev = ALEMBIC_REV_RE.search(text)
        tag = f"alembic:{rev.group(1) if rev else stem}"
    for rx, op in opsets:
        for m in rx.finditer(text):
            out.append({"table": m.group(1).lower(), "op": op,
                        "line": _line(text, m.start()), "changeset": tag})
    return out


# Newline offsets computed once per text (extraction is single-threaded, so a
# last-text memo suffices), O(log n) per lookup — replaces the per-match prefix
# re-scan, O(text × matches) on big changelogs. Parity: makeLineAt (Node).
_ln_text = None
_ln_offs = None


def _line(text, idx):
    global _ln_text, _ln_offs
    if text is not _ln_text:
        offs = []
        find = text.find
        i = find("\n")
        while i != -1:
            offs.append(i)
            i = find("\n", i + 1)
        _ln_text, _ln_offs = text, offs
    return bisect_left(_ln_offs, idx) + 1


def extract_changelog(relpath, text):
    out = []
    changesets = []
    for m in XML_CS_RE.finditer(text):
        changesets.append((m.start(), f"{m.group(2)}:{m.group(1)}"))
    for m in SQL_CS_RE.finditer(text):
        changesets.append((m.start(), f"{m.group(1)}:{m.group(2)}"))
    for m in YAML_CS_RE.finditer(text):
        changesets.append((m.start(), f"{m.group(2)}:{m.group(1)}"))
    changesets.sort()

    def cs_at(i):
        last = None
        for idx, cid in changesets:
            if idx <= i:
                last = cid
            else:
                break
        return last

    # Flyway-style versioned SQL (V2__add_x.sql) carries no liquibase changeset
    # comment; tag its ops with the migration filename so history stays legible
    ft = re.search(r"(^|/)((?:[VUR]\d*|R)__[^/]+)\.sql$", relpath, re.I)
    file_tag = ft.group(2) if ft else None
    ops = XML_OPS if relpath.endswith(".xml") else ([] if relpath.endswith(".sql") else YAML_OPS)
    for rx, op in ops:
        for m in rx.finditer(text):
            out.append({"table": m.group(1).strip("'\"").lower(), "op": op,
                        "line": _line(text, m.start()), "changeset": cs_at(m.start())})
    routine_ops = XML_ROUTINE_OPS if relpath.endswith(".xml") else ([] if relpath.endswith(".sql") else YAML_ROUTINE_OPS)
    for rx, op, ns in routine_ops:
        for m in rx.finditer(text):
            n = _split_name(m.group(1).replace("'", "").replace('"', ""))
            if _is_real_object(n):
                out.append({"table": ns + n["name"], "op": op, "line": _line(text, m.start()),
                            "changeset": cs_at(m.start())})
    # raw SQL in .sql files and <sql> blocks (comment-blanked in .sql, so a
    # commented-out CREATE TABLE is not a definition)
    src = _blank_sql_comments(text) if relpath.endswith(".sql") else text
    for m in SQL_DDL_RE.finditer(src):
        n = _split_name(m.group(2))
        if not _is_real_object(n):
            continue  # #temp / @table variables are not schema
        kw = m.group(1).upper()
        op = "create" if kw.startswith("CREATE") else "drop" if kw.startswith("DROP") else "alter"
        out.append({"table": n["name"], "op": op,
                    "line": _line(text, m.start()), "changeset": cs_at(m.start()) or file_tag})
    # procedures / views / functions (triggers: see extract_routine_access)
    for r in _parse_routines(relpath, text)[1]:
        if r["kind"] == "trigger":
            continue
        out.append({"table": ("proc:" if r["kind"] == "proc" else "") + r["name"], "op": f"{r['op']} {r['kind']}",
                    "line": _line(text, r["idx"]), "changeset": cs_at(r["idx"]) or file_tag})
    return out


def _camel_to_snake(s):
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s).lower()


def _tables_from_sql(sql):
    write = bool(re.match(r"^\s*(insert|update|delete|merge|truncate)", sql, re.I))
    tables = set()
    for m in SQL_TABLES_RE.finditer(sql):
        n = _split_name(m.group(1))
        if _is_real_object(n) and n["name"] not in SQL_NOISE:
            tables.add(n["name"])
    return list(tables), ("write" if write else "read")


def extract_entities(text):
    out = {}
    for m in ANN_CLASS_RE.finditer(text):
        if not re.search(r"@Entity\b", m.group(1)):
            continue
        t = TABLE_NAME_RE.search(m.group(1))
        out[m.group(2)] = (t.group(1) if t else _camel_to_snake(m.group(2))).lower()
    return out


def extract_lombok_symbols(text):
    """Symbols Lombok generates at compile time, synthesized into the graph."""
    out = []
    for m in ANN_CLASS_RE.finditer(text):
        ann, cls = m.group(1), m.group(2)
        has_data = bool(re.search(r"@Data\b", ann))
        has_value = bool(re.search(r"@Value\b", ann))
        getter = has_data or has_value or bool(re.search(r"@Getter\b", ann))
        setter = (has_data or bool(re.search(r"@Setter\b", ann))) and not has_value
        builder = bool(re.search(r"@(?:Super)?Builder\b", ann))
        if not (getter or setter or builder):
            continue
        line = text.count("\n", 0, m.start()) + 1
        if builder:
            out.append({"name": "builder", "kind": "method", "line": line,
                        "sig": "() [Lombok-generated]", "parent": cls})
            out.append({"name": "build", "kind": "method", "line": line,
                        "sig": "() [Lombok-generated]", "parent": cls})
        for f in FIELD_RE.finditer(text):
            typ, name = f.group(1), f.group(2)
            fline = text.count("\n", 0, f.start()) + 1
            is_bool = typ.strip() in ("boolean", "Boolean")
            if getter:
                out.append({"name": ("is" if is_bool else "get") + name[0].upper() + name[1:],
                            "kind": "method", "line": fline, "sig": f"() : {typ} [Lombok-generated]", "parent": cls})
            if setter:
                out.append({"name": "set" + name[0].upper() + name[1:], "kind": "method",
                            "line": fline, "sig": f"({typ} {name}) [Lombok-generated]", "parent": cls})
    return out


# ---------- Generic access beyond the JVM: SQLAlchemy + literal driver SQL ----------
SA_TABLENAME_RE = re.compile(r"__tablename__\s*=\s*[\"']([\w]+)[\"']")
SA_TABLE_RE = re.compile(r"\bTable\s*\(\s*[\"']([\w]+)[\"']")
EXEC_SQL_RE = re.compile(r"\b(?:execute(?:many)?|query|raw|exec_driver_sql)\s*\(\s*(?:text\s*\(\s*)?([\"'`])([\s\S]{0,400}?)\1")


def extract_generic_db_access(text):
    """DB access in non-JVM code: SQLAlchemy models/tables and any driver call
    with a literal SQL string (psycopg/sqlite3/knex/pg/generic execute/query)."""
    out, seen = [], set()

    def push(table, kind, mode, idx, detail):
        key = (table, kind, _line(text, idx))
        if key not in seen:
            seen.add(key)
            out.append({"table": table, "kind": kind, "mode": mode,
                        "line": _line(text, idx), "detail": detail})

    for m in SA_TABLENAME_RE.finditer(text):
        push(m.group(1).lower(), "entity", "rw", m.start(), "SQLAlchemy __tablename__")
    for m in SA_TABLE_RE.finditer(text):
        push(m.group(1).lower(), "entity", "rw", m.start(), "SQLAlchemy Table")
    for m in EXEC_SQL_RE.finditer(text):
        sql = m.group(2)
        if not re.search(r"\b(FROM|JOIN|INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO)\b", sql, re.I):
            continue
        tables, mode = _tables_from_sql(sql)
        for t in tables:
            push(t, "sql", mode, m.start(), "driver SQL")
    if PROC_HINT_RE.search(text):
        for r in _proc_call_sites(text, {}):
            key = (r["table"], r["kind"], r["line"])
            if key not in seen:
                seen.add(key)
                out.append(r)
    return out


def extract_db_access(text, entity_tables, constants):
    out, seen = [], set()

    def push(table, kind, mode, idx, detail):
        key = (table, kind, _line(text, idx), detail)
        if key not in seen:
            seen.add(key)
            out.append({"table": table, "kind": kind, "mode": mode,
                        "line": _line(text, idx), "detail": detail})

    for m in ANN_CLASS_RE.finditer(text):
        if not re.search(r"@Entity\b", m.group(1)):
            continue
        t = TABLE_NAME_RE.search(m.group(1))
        push((t.group(1) if t else _camel_to_snake(m.group(2))).lower(), "entity", "rw", m.start(), m.group(2))
    for m in REPO_RE.finditer(text):
        table = entity_tables.get(m.group(2))
        if table:
            push(table, "repository", "rw", m.start(), f"{m.group(1)}<{m.group(2)}>")
    for m in QUERY_ANN_RE.finditer(text):
        q = m.group(1)
        if m.group(2):
            tables, mode = _tables_from_sql(q)
            for t in tables:
                push(t, "sql", mode, m.start(), "@Query(native)")
        else:
            for em in JPQL_ENTITY_RE.finditer(q):
                table = entity_tables.get(em.group(1))
                if table:
                    mode = "write" if re.search(r"update|delete", q, re.I) else "read"
                    push(table, "sql", mode, m.start(), f"@Query(JPQL {em.group(1)})")
    if "com.querydsl" in text or "JPAQueryFactory" in text:
        for m in re.finditer(r"\bQ([A-Z]\w+)\b", text):
            table = entity_tables.get(m.group(1))
            if not table:
                continue
            ctx = text[max(0, m.start() - 80):m.start() + 80]
            mode = "write" if re.search(r"\.(update|delete|insert)\s*\(", ctx) else "read"
            push(table, "sql", mode, m.start(), f"Querydsl Q{m.group(1)}")
    for m in JDBC_RE.finditer(text):
        sql = m.group(2)
        from_constant = not sql.startswith('"')
        sql = constants.get(sql, "") if from_constant else sql[1:-1]
        if not sql:
            continue
        # a constant's {call x}/EXEC x is credited here, at the call site; a literal
        # one is already credited by the string-literal scan in _proc_call_sites
        proc = _procs_in_sql(sql) if from_constant else None
        if proc:
            push("proc:" + proc["name"], "proc", "exec", m.start(), f"JdbcTemplate.{m.group(1)}")
        tables, mode = _tables_from_sql(sql)
        for t in tables:
            push(t, "sql", mode, m.start(), f"JdbcTemplate.{m.group(1)}")
    if PROC_HINT_RE.search(text):
        for r in _proc_call_sites(text, constants):
            key = (r["table"], r["kind"], r["line"], r["detail"])
            if key not in seen:
                seen.add(key)
                out.append(r)
    return out
