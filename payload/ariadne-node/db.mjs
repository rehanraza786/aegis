/**
 * Database topology extraction for Spring Boot + Liquibase:
 *   definitions. Liquibase changelogs (XML / YAML / formatted SQL):
 *       createTable, addColumn, dropTable, renameTable, FKs, raw CREATE TABLE
 *   access. JPA @Entity/@Table mapping, Spring Data repositories
 *       (XRepository extends JpaRepository<Entity,...>), @Query (JPQL + native),
 *       JdbcTemplate query/update/execute with literal or constant SQL.
 * Correlates table -> changesets that shaped it + every code site touching it,
 * with read/write mode, enabling drift detection (entity without changelog,
 * table without any code access).
 */

const CHANGELOG_PATH_RE = /(changelog|migration|liquibase)/i;

/** Newline offsets scanned once, O(log n) per lookup — replaces the per-match
 *  prefix re-scan (O(text × matches) on big changelogs). Parity: _line (Python). */
function makeLineAt(text) {
  let offs = null;
  return (idx) => {
    if (!offs) {
      offs = [];
      for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) offs.push(i);
    }
    let lo = 0, hi = offs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offs[mid] < idx) lo = mid + 1; else hi = mid;
    }
    return lo + 1;
  };
}

// ---------- Liquibase parsing ----------
const XML_CHANGESET_RE = /<changeSet[^>]*\bid\s*=\s*"([^"]+)"[^>]*\bauthor\s*=\s*"([^"]+)"/g;
const XML_OPS = [
  [/<createTable[^>]*tableName\s*=\s*"([^"]+)"/g, "create"],
  [/<addColumn[^>]*tableName\s*=\s*"([^"]+)"/g, "alter"],
  [/<dropTable[^>]*tableName\s*=\s*"([^"]+)"/g, "drop"],
  [/<renameTable[^>]*newTableName\s*=\s*"([^"]+)"/g, "create"],
  [/<renameTable[^>]*oldTableName\s*=\s*"([^"]+)"/g, "drop"],
  [/<addForeignKeyConstraint[^>]*baseTableName\s*=\s*"([^"]+)"/g, "alter"],
  [/<(?:addUniqueConstraint|createIndex|addNotNullConstraint|modifyDataType|addPrimaryKey)[^>]*tableName\s*=\s*"([^"]+)"/g, "alter"],
];
const YAML_OPS = [
  [/(?:createTable|renameTable):\s*[\s\S]{0,200}?(?:tableName|newTableName):\s*([\w"']+)/g, "create"],
  [/(?:addColumn|addForeignKeyConstraint|createIndex|addUniqueConstraint|modifyDataType|addPrimaryKey):\s*[\s\S]{0,200}?(?:tableName|baseTableName):\s*([\w"']+)/g, "alter"],
  [/dropTable:\s*[\s\S]{0,200}?tableName:\s*([\w"']+)/g, "drop"],
];
const SQL_DDL_RE = /\b(CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+[`"]?([\w.]+)[`"]?/gi;

export function isChangelog(relpath, text) {
  if (!/\.(xml|ya?ml|sql)$/.test(relpath)) return false;
  if (CHANGELOG_PATH_RE.test(relpath)) return /databaseChangeLog|--\s*liquibase|<changeSet|changeSet:/i.test(text) || relpath.endsWith(".sql");
  return /databaseChangeLog|--\s*liquibase formatted sql/i.test(text);
}

// ---------- Migrations beyond Liquibase: Prisma, Rails, Alembic ----------
const PRISMA_MODEL_RE = /\bmodel\s+(\w+)\s*\{([^}]*)\}/g;
const PRISMA_MAP_RE = /@@map\s*\(\s*"([^"]+)"\s*\)/;
const RAILS_OPS = [
  [/\bcreate_table\s+["':]([\w]+)/g, "create"],
  [/\b(?:add_column|change_column|add_index|remove_column|rename_column|add_reference)\s+["':]([\w]+)/g, "alter"],
  [/\bdrop_table\s+["':]([\w]+)/g, "drop"],
];
const ALEMBIC_OPS = [
  [/\bop\.create_table\s*\(\s*["']([\w]+)/g, "create"],
  [/\bop\.(?:add_column|alter_column|create_index|drop_column|create_foreign_key)\s*\(\s*["']([\w]+)/g, "alter"],
  [/\bop\.drop_table\s*\(\s*["']([\w]+)/g, "drop"],
];
const ALEMBIC_REV_RE = /^revision\s*=\s*["']([\w]+)["']/m;

/** Schema-defining files in non-Liquibase formats. */
export function isSchemaFile(relpath, text) {
  if (relpath.endsWith(".prisma")) return /\bmodel\s+\w+\s*\{/.test(text);
  if (relpath.endsWith(".rb")) return (/(^|\/)db\/(schema\.rb$|migrate\/)/.test(relpath)) && /create_table|add_column|drop_table/.test(text);
  if (relpath.endsWith(".py")) return /\bop\.(create_table|add_column|alter_column|drop_table)/.test(text) && /(migrations?|alembic|versions)\//.test(relpath);
  return false;
}

/** [{table, op, line, changeset}] from Prisma schema / Rails schema+migrations / Alembic revisions. */
export function extractSchemaDefs(relpath, text) {
  const out = [];
  const lineAt = makeLineAt(text);
  const stem = relpath.split("/").pop().replace(/\.\w+$/, "");
  if (relpath.endsWith(".prisma")) {
    for (const m of text.matchAll(PRISMA_MODEL_RE)) {
      // Prisma tables are the model name verbatim unless @@map overrides
      const table = (m[2].match(PRISMA_MAP_RE)?.[1] ?? m[1]).toLowerCase();
      out.push({ table, op: "create", line: lineAt(m.index), changeset: `prisma:${m[1]}` });
    }
    return out;
  }
  const opsets = relpath.endsWith(".rb") ? RAILS_OPS : ALEMBIC_OPS;
  const tag = relpath.endsWith(".rb")
    ? (relpath.endsWith("schema.rb") ? "rails:schema" : `rails:${stem}`)
    : `alembic:${text.match(ALEMBIC_REV_RE)?.[1] ?? stem}`;
  for (const [re, op] of opsets) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) out.push({ table: m[1].toLowerCase(), op, line: lineAt(m.index), changeset: tag });
  }
  return out;
}

/** Returns [{table, op, line, changeset}] from one changelog file. */
export function extractChangelog(relpath, text) {
  const out = [];
  const lineAt = makeLineAt(text);
  // nearest preceding changeset id for context
  const changesets = [];
  for (const m of text.matchAll(XML_CHANGESET_RE)) changesets.push({ idx: m.index, id: `${m[2]}:${m[1]}` });
  for (const m of text.matchAll(/--\s*changeset\s+([\w.\-]+):([\w.\-]+)/gi)) changesets.push({ idx: m.index, id: `${m[1]}:${m[2]}` });
  for (const m of text.matchAll(/-\s*changeSet:\s*[\s\S]{0,120}?id:\s*([\w.\-]+)[\s\S]{0,120}?author:\s*([\w.\-]+)/g)) changesets.push({ idx: m.index, id: `${m[2]}:${m[1]}` });
  changesets.sort((a, b) => a.idx - b.idx);
  const csAt = (i) => { let last = null; for (const c of changesets) { if (c.idx <= i) last = c.id; else break; } return last; };

  // Flyway-style versioned SQL (V2__add_x.sql) carries no liquibase changeset
  // comment; tag its ops with the migration filename so history stays legible
  const fileTag = relpath.match(/(^|\/)((?:[VUR]\d*|R)__[^/]+)\.sql$/i)?.[2] ?? null;
  const opsets = relpath.endsWith(".xml") ? XML_OPS : relpath.endsWith(".sql") ? [] : YAML_OPS;
  for (const [re, op] of opsets) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      out.push({ table: m[1].replace(/['"]/g, "").toLowerCase(), op, line: lineAt(m.index), changeset: csAt(m.index) });
    }
  }
  // raw SQL in .sql files and <sql> blocks
  for (const m of text.matchAll(SQL_DDL_RE)) {
    const op = /^CREATE/i.test(m[1]) ? "create" : /^DROP/i.test(m[1]) ? "drop" : "alter";
    out.push({ table: m[2].split(".").pop().toLowerCase(), op, line: lineAt(m.index), changeset: csAt(m.index) ?? fileTag });
  }
  return out;
}

// ---------- Spring Boot access parsing ----------
// Annotation-block-before-class: order-independent, Lombok-stack tolerant
const ANN_CLASS_RE = /((?:@\w+(?:\s*\([^)]*\))?\s*)+)(?:public\s+|final\s+|abstract\s+)*class\s+(\w+)/g;
const TABLE_NAME_RE = /@Table\s*\(\s*(?:[^)]*?name\s*=\s*)?"([^"]+)"/;
const REPO_RE = /interface\s+(\w+)\s+extends\s+(?:\w+\.)*(?:Jpa|Crud|Paging(?:AndSorting)?|List(?:Crud|Paging)?|Reactive\w*)Repository\s*<\s*(\w+)/g;
const QUERY_ANN_RE = /@Query\s*\(\s*(?:value\s*=\s*)?"([\s\S]*?)"\s*(?:,\s*nativeQuery\s*=\s*(true))?\s*\)/g;
const JDBC_RE = /(?:jdbc\w*|template|namedParameterJdbcTemplate)\s*\.\s*(query\w*|update|execute|batchUpdate)\s*\(\s*("(?:[^"\\]|\\.)*"|\w+)/gi;
const SQL_TABLES_RE = /\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO)\s+[`"]?([a-zA-Z_][\w.]*)[`"]?/gi;

const camelToSnake = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const SQL_KEYWORD_NOISE = new Set(["select", "dual", "values", "set", "where", "on"]);

function tablesFromSql(sql) {
  const tables = new Set();
  const isWrite = /^\s*(insert|update|delete|merge|truncate)/i.test(sql);
  for (const m of sql.matchAll(SQL_TABLES_RE)) {
    const t = m[1].split(".").pop().toLowerCase();
    if (!SQL_KEYWORD_NOISE.has(t)) tables.add(t);
  }
  return { tables: [...tables], mode: isWrite ? "write" : "read" };
}

/**
 * Extract DB access sites from one java/kotlin file.
 * entityTables: Map className -> tableName (built across the repo, pass 1)
 * constants: repo-wide string constants (shared with the kafka pass)
 * Returns [{table, kind, mode, line, detail}]
 */
export function extractEntities(text) {
  const out = new Map();
  for (const m of text.matchAll(ANN_CLASS_RE)) {
    if (!/@Entity\b/.test(m[1])) continue;
    const table = m[1].match(TABLE_NAME_RE)?.[1] ?? camelToSnake(m[2]);
    out.set(m[2], table.toLowerCase());
  }
  return out;
}

// ---------- Lombok synthesis: generated accessors/builders as graph symbols ----------
const FIELD_RE = /(?:private|protected)\s+(?!static\s+final)(?:final\s+)?([\w.$]+(?:\s*<[^;=]*?>)?(?:\[\])?)\s+(\w+)\s*(?:=|;)/g;
const cap = (s) => s[0].toUpperCase() + s.slice(1);

/** Symbols Lombok will generate at compile time, so find_symbol/outline see them. */
export function extractLombokSymbols(text) {
  const out = [];
  const lineAt = makeLineAt(text);
  for (const m of text.matchAll(ANN_CLASS_RE)) {
    const ann = m[1];
    const cls = m[2];
    const hasData = /@Data\b/.test(ann), hasValue = /@Value\b/.test(ann);
    const getter = hasData || hasValue || /@Getter\b/.test(ann);
    const setter = (hasData || /@Setter\b/.test(ann)) && !hasValue;
    const builder = /@(?:Super)?Builder\b/.test(ann);
    if (!getter && !setter && !builder) continue;
    if (builder) {
      out.push({ name: "builder", kind: "method", line: lineAt(m.index), sig: "() [Lombok-generated]", parent: cls });
      out.push({ name: "build", kind: "method", line: lineAt(m.index), sig: "() [Lombok-generated]", parent: cls });
    }
    FIELD_RE.lastIndex = 0;
    for (const f of text.matchAll(FIELD_RE)) {
      const [ , type, name ] = f;
      const line = lineAt(f.index);
      const isBool = /^(boolean|Boolean)$/.test(type.trim());
      if (getter) out.push({ name: (isBool ? "is" : "get") + cap(name), kind: "method", line, sig: `() : ${type} [Lombok-generated]`, parent: cls });
      if (setter) out.push({ name: "set" + cap(name), kind: "method", line, sig: `(${type} ${name}) [Lombok-generated]`, parent: cls });
    }
  }
  return out;
}

// ---------- Generic access beyond the JVM: SQLAlchemy + literal driver SQL ----------
const SA_TABLENAME_RE = /__tablename__\s*=\s*["']([\w]+)["']/g;
const SA_TABLE_RE = /\bTable\s*\(\s*["']([\w]+)["']/g;
const EXEC_SQL_RE = /\b(?:execute(?:many)?|query|raw|exec_driver_sql)\s*\(\s*(?:text\s*\(\s*)?(["'`])([\s\S]{0,400}?)\1/g;

/** DB access in non-JVM code: SQLAlchemy models/tables and any driver call
 *  with a literal SQL string (psycopg/sqlite3/knex/pg/generic execute/query). */
export function extractGenericDbAccess(text) {
  const out = [];
  const lineAt = makeLineAt(text);
  for (const m of text.matchAll(SA_TABLENAME_RE)) {
    out.push({ table: m[1].toLowerCase(), kind: "entity", mode: "rw", line: lineAt(m.index), detail: "SQLAlchemy __tablename__" });
  }
  for (const m of text.matchAll(SA_TABLE_RE)) {
    out.push({ table: m[1].toLowerCase(), kind: "entity", mode: "rw", line: lineAt(m.index), detail: "SQLAlchemy Table" });
  }
  for (const m of text.matchAll(EXEC_SQL_RE)) {
    const sql = m[2];
    if (!/\b(FROM|JOIN|INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO)\b/i.test(sql)) continue;
    const { tables, mode } = tablesFromSql(sql);
    for (const t of tables) out.push({ table: t, kind: "sql", mode, line: lineAt(m.index), detail: "driver SQL" });
  }
  const seen = new Set();
  return out.filter((e) => {
    const k = `${e.table}|${e.kind}|${e.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function extractDbAccess(text, entityTables, constants) {
  const out = [];
  const lineAt = makeLineAt(text);
  // entities declared in this file (annotation-block parse: order-independent, Lombok-safe)
  for (const m of text.matchAll(ANN_CLASS_RE)) {
    if (!/@Entity\b/.test(m[1])) continue;
    const table = (m[1].match(TABLE_NAME_RE)?.[1] ?? camelToSnake(m[2])).toLowerCase();
    out.push({ table, kind: "entity", mode: "rw", line: lineAt(m.index), detail: m[2] });
  }
  // repositories -> entity -> table
  for (const m of text.matchAll(REPO_RE)) {
    const table = entityTables.get(m[2]);
    if (table) out.push({ table, kind: "repository", mode: "rw", line: lineAt(m.index), detail: `${m[1]}<${m[2]}>` });
  }
  // @Query: native -> SQL tables; JPQL -> entity names
  for (const m of text.matchAll(QUERY_ANN_RE)) {
    const q = m[1];
    if (m[2]) {
      const { tables, mode } = tablesFromSql(q);
      for (const t of tables) out.push({ table: t, kind: "sql", mode, line: lineAt(m.index), detail: "@Query(native)" });
    } else {
      for (const em of q.matchAll(/\b(?:FROM|JOIN|UPDATE|DELETE\s+FROM)\s+(\w+)/gi)) {
        const table = entityTables.get(em[1]);
        if (table) out.push({ table, kind: "sql", mode: /update|delete/i.test(q) ? "write" : "read", line: lineAt(m.index), detail: `@Query(JPQL ${em[1]})` });
      }
    }
  }
  // Querydsl: Q-classes map to entities (QOrderEntity -> OrderEntity -> table)
  if (/com\.querydsl|JPAQueryFactory/.test(text)) {
    for (const m of text.matchAll(/\bQ([A-Z]\w+)\b/g)) {
      const table = entityTables.get(m[1]);
      if (!table) continue;
      const ctx = text.slice(Math.max(0, m.index - 80), m.index + 80);
      const mode = /\.(update|delete|insert)\s*\(/.test(ctx) ? "write" : "read";
      out.push({ table, kind: "sql", mode, line: lineAt(m.index), detail: `Querydsl Q${m[1]}` });
    }
  }
  // JdbcTemplate with literal or constant SQL
  for (const m of text.matchAll(JDBC_RE)) {
    let sql = m[2];
    if (!sql.startsWith('"')) sql = constants.get(sql) ?? "";
    else sql = sql.slice(1, -1);
    if (!sql) continue;
    const { tables, mode } = tablesFromSql(sql);
    for (const t of tables) out.push({ table: t, kind: "sql", mode, line: lineAt(m.index), detail: `JdbcTemplate.${m[1]}` });
  }
  // de-dup
  const seen = new Set();
  return out.filter((e) => {
    const k = `${e.table}|${e.kind}|${e.line}|${e.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
