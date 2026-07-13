"""DB topology extraction (Python edition; mirror of db.mjs).
Liquibase changelogs (XML/YAML/formatted SQL) -> table definitions;
Spring Boot code (JPA entities, Spring Data repos, @Query, JdbcTemplate) -> access sites."""
import re

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
SQL_DDL_RE = re.compile(r'\b(CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+[`"]?([\w.]+)[`"]?', re.I)
ANN_CLASS_RE = re.compile(r"((?:@\w+(?:\s*\([^)]*\))?\s*)+)(?:public\s+|final\s+|abstract\s+)*class\s+(\w+)")
TABLE_NAME_RE = re.compile(r'@Table\s*\(\s*(?:[^)]*?name\s*=\s*)?"([^"]+)"')
FIELD_RE = re.compile(r"(?:private|protected)\s+(?!static\s+final)(?:final\s+)?([\w.$]+(?:\s*<[^;=]*?>)?(?:\[\])?)\s+(\w+)\s*(?:=|;)")
REPO_RE = re.compile(r"interface\s+(\w+)\s+extends\s+(?:\w+\.)*(?:Jpa|Crud|Paging(?:AndSorting)?|List(?:Crud|Paging)?|Reactive\w*)Repository\s*<\s*(\w+)")
QUERY_ANN_RE = re.compile(r'@Query\s*\(\s*(?:value\s*=\s*)?"([\s\S]*?)"\s*(?:,\s*nativeQuery\s*=\s*(true))?\s*\)')
JDBC_RE = re.compile(r'(?:jdbc\w*|template|namedParameterJdbcTemplate)\s*\.\s*(query\w*|update|execute|batchUpdate)\s*\(\s*("(?:[^"\\]|\\.)*"|\w+)', re.I)
SQL_TABLES_RE = re.compile(r'\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO)\s+[`"]?([a-zA-Z_][\w.]*)[`"]?', re.I)
JPQL_ENTITY_RE = re.compile(r"\b(?:FROM|JOIN|UPDATE|DELETE\s+FROM)\s+(\w+)", re.I)
SQL_NOISE = {"select", "dual", "values", "set", "where", "on"}


def is_changelog(relpath, text):
    if not re.search(r"\.(xml|ya?ml|sql)$", relpath):
        return False
    if CHANGELOG_PATH_RE.search(relpath):
        return bool(CHANGELOG_CONTENT_RE.search(text)) or relpath.endswith(".sql")
    return bool(re.search(r"databaseChangeLog|--\s*liquibase formatted sql", text, re.I))


def _line(text, idx):
    return text.count("\n", 0, idx) + 1


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

    ops = XML_OPS if relpath.endswith(".xml") else ([] if relpath.endswith(".sql") else YAML_OPS)
    for rx, op in ops:
        for m in rx.finditer(text):
            out.append({"table": m.group(1).strip("'\"").lower(), "op": op,
                        "line": _line(text, m.start()), "changeset": cs_at(m.start())})
    for m in SQL_DDL_RE.finditer(text):
        kw = m.group(1).upper()
        op = "create" if kw.startswith("CREATE") else "drop" if kw.startswith("DROP") else "alter"
        out.append({"table": m.group(2).split(".")[-1].lower(), "op": op,
                    "line": _line(text, m.start()), "changeset": cs_at(m.start())})
    return out


def _camel_to_snake(s):
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s).lower()


def _tables_from_sql(sql):
    write = bool(re.match(r"^\s*(insert|update|delete|merge|truncate)", sql, re.I))
    tables = {m.group(1).split(".")[-1].lower() for m in SQL_TABLES_RE.finditer(sql)}
    return [t for t in tables if t not in SQL_NOISE], ("write" if write else "read")


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
        sql = constants.get(sql, "") if not sql.startswith('"') else sql[1:-1]
        if not sql:
            continue
        tables, mode = _tables_from_sql(sql)
        for t in tables:
            push(t, "sql", mode, m.start(), f"JdbcTemplate.{m.group(1)}")
    return out
