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
// Liquibase's own view/procedure change types (a <createProcedure> body carries its
// CREATE PROCEDURE header, which the routine pass reads, so only drops need a rule)
const XML_ROUTINE_OPS = [
  [/<createView[^>]*viewName\s*=\s*"([^"]+)"/g, "create view", ""],
  [/<dropView[^>]*viewName\s*=\s*"([^"]+)"/g, "drop view", ""],
  [/<dropProcedure[^>]*procedureName\s*=\s*"([^"]+)"/g, "drop proc", "proc:"],
];
const YAML_ROUTINE_OPS = [
  [/createView:\s*[\s\S]{0,200}?viewName:\s*([\w."'\[\]]+)/g, "create view", ""],
  [/dropView:\s*[\s\S]{0,200}?viewName:\s*([\w."'\[\]]+)/g, "drop view", ""],
  [/dropProcedure:\s*[\s\S]{0,200}?procedureName:\s*([\w."'\[\]]+)/g, "drop proc", "proc:"],
];
const YAML_OPS = [
  [/(?:createTable|renameTable):\s*[\s\S]{0,200}?(?:tableName|newTableName):\s*([\w"']+)/g, "create"],
  [/(?:addColumn|addForeignKeyConstraint|createIndex|addUniqueConstraint|modifyDataType|addPrimaryKey):\s*[\s\S]{0,200}?(?:tableName|baseTableName):\s*([\w"']+)/g, "alter"],
  [/dropTable:\s*[\s\S]{0,200}?tableName:\s*([\w"']+)/g, "drop"],
];
// ---------- Identifiers (shared by DDL, DML and the T-SQL routine layer) ----------
// One name part: [bracketed] (SQL Server), "quoted", `ticked`, or bare. Bare parts
// may start with # or @ so temp tables and table variables are CONSUMED (and then
// rejected by isRealObject) instead of half-matching. Up to db.schema.object.
const ID_PART = String.raw`(?:\[[^\]\r\n]+\]|"[^"\r\n]+"|\x60[^\x60\r\n]+\x60|[A-Za-z_#@][\w$#@]*)`;
const QNAME = String.raw`${ID_PART}(?:\.${ID_PART}){0,2}`;

/** "[dbo].[Orders]" -> {name: "orders", schema: "dbo", db: null}. Parity: _split_name (Python). */
function splitName(raw) {
  const parts = (raw.match(/\[[^\]]+\]|"[^"]+"|`[^`]+`|[^.\s]+/g) ?? [])
    .map((p) => p.replace(/^[[\"`]|[\]\"`]$/g, "").toLowerCase());
  return { name: parts[parts.length - 1] ?? "", schema: parts.length > 1 ? parts[parts.length - 2] : null, db: parts.length > 2 ? parts[0] : null };
}
/** Real schema objects only: no #temp, no @variables, no catalog views. */
const isRealObject = (n) => !!n.name && /^[a-z_]/.test(n.name) && n.schema !== "sys" && n.schema !== "information_schema";

const SQL_DDL_RE = new RegExp(String.raw`\b(CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+(${QNAME})`, "gi");
// A .sql file that defines schema objects is a schema source even outside a
// changelog/migration folder: SSDT projects, db/procs/*.sql, schema.sql.
const SQL_OBJECT_FILE_RE = /^\s*(?:CREATE(?:\s+OR\s+(?:ALTER|REPLACE))?|ALTER)\s+(?:PROC(?:EDURE)?|VIEW|FUNCTION|TRIGGER|TABLE)\b/im;

export function isChangelog(relpath, text) {
  if (!/\.(xml|ya?ml|sql)$/.test(relpath)) return false;
  if (CHANGELOG_PATH_RE.test(relpath)) return /databaseChangeLog|--\s*liquibase|<changeSet|changeSet:/i.test(text) || relpath.endsWith(".sql");
  if (relpath.endsWith(".sql") && SQL_OBJECT_FILE_RE.test(text)) return true;
  return /databaseChangeLog|--\s*liquibase formatted sql/i.test(text);
}

// ---------- SQL Server routines: procedures, views, functions, triggers ----------
// Procedures live in their own namespace (`proc:<name>`) because code EXECs them
// rather than selecting from them; views and functions share the table namespace
// because code reads them exactly like tables (FROM vw_x, CROSS APPLY fn_x(...)).
// Triggers are not objects code touches, so they get no definition row: their
// table gets a `trigger` access row and their body's writes are attributed to
// them, which is what change impact needs ("writing orders also writes audit_log").
const ROUTINE_HDR_RE = new RegExp(String.raw`\b(CREATE(?:\s+OR\s+(?:ALTER|REPLACE))?|ALTER|DROP)\s+(PROC(?:EDURE)?|VIEW|FUNCTION|TRIGGER)\s+(?:IF\s+EXISTS\s+)?(${QNAME})`, "gi");
const TRIGGER_ON_RE = new RegExp(String.raw`^\s+ON\s+(${QNAME})`, "i");
const BATCH_END_RE = /^[ \t]*GO[ \t]*(?:--[^\n]*)?\r?$|--\s*changeset\b|<\/(?:sql|createProcedure|changeSet)>/gim;
const BODY_WRITE_RE = new RegExp(String.raw`\b(?:INSERT\s+(?:INTO\s+)?|UPDATE\s+(?:TOP\s*\([^)]*\)\s*)?|DELETE\s+(?:TOP\s*\([^)]*\)\s*)?(?:FROM\s+)?|MERGE\s+(?:TOP\s*\([^)]*\)\s*)?(?:INTO\s+)?|TRUNCATE\s+TABLE\s+)(${QNAME})`, "gi");
const BODY_READ_RE = new RegExp(String.raw`\b(FROM|JOIN|USING|APPLY)\s+(${QNAME})(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?`, "gi");
const BODY_EXEC_RE = new RegExp(String.raw`\bEXEC(?:UTE)?\s+(?:@\w+\s*=\s*)?(${QNAME})`, "gi");
const CTE_RE = /(?:\bWITH|,)\s*([A-Za-z_]\w*)\s*(?:\([^()]*\)\s*)?AS\s*\(/gi;
const BODY_NOISE = new Set(["select", "dual", "values", "set", "where", "on", "as", "of", "top", "table", "output",
  "statistics", "inserted", "deleted", "openjson", "openxml", "openquery", "openrowset", "opendatasource", "string_split"]);
const ALIAS_STOP = new Set(["where", "on", "join", "inner", "left", "right", "full", "cross", "outer", "with", "group",
  "order", "set", "as", "union", "when", "then", "output", "option", "pivot", "unpivot", "apply", "values", "select",
  "into", "for", "having", "except", "intersect", "end", "begin", "if", "else", "return", "declare", "exec", "execute",
  "insert", "update", "delete", "merge", "go", "using", "not", "and", "or", "is"]);
const SYSTEM_PROCS = new Set(["sp_executesql", "sp_rename", "sp_getapplock", "sp_releaseapplock", "sp_set_session_context",
  "sp_send_dbmail", "sp_addextendedproperty", "sp_updateextendedproperty", "sp_refreshview", "sp_recompile", "sp_help",
  "sp_helptext", "sp_who", "sp_who2", "sp_lock", "sp_configure", "sp_start_job"]);
const isSystemProc = (n) => n.name.startsWith("xp_") || SYSTEM_PROCS.has(n.name) || n.db === "master" || n.db === "msdb";

/** Blank `--` and block comments with spaces (newlines kept), so offsets and
 *  line numbers still line up with the original text. 'strings' survive. */
function blankSqlComments(text) {
  return text.replace(/('(?:[^']|'')*')|--[^\n]*|\/\*[\s\S]*?\*\//g, (m, s) => (s ? m : m.replace(/[^\n]/g, " ")));
}

function parseRoutines(relpath, text) {
  const src = relpath.endsWith(".sql") ? blankSqlComments(text) : text;
  const hdrs = [...src.matchAll(ROUTINE_HDR_RE)];
  if (!hdrs.length) return { src, routines: [] };
  const bounds = hdrs.map((m) => m.index);
  for (const m of src.matchAll(BATCH_END_RE)) bounds.push(m.index);
  for (const m of src.matchAll(SQL_DDL_RE)) if (isRealObject(splitName(m[2]))) bounds.push(m.index);
  bounds.sort((a, b) => a - b);
  const routines = [];
  for (const m of hdrs) {
    const n = splitName(m[3]);
    if (!isRealObject(n)) continue;
    const kind = /^PROC/i.test(m[2]) ? "proc" : m[2].toLowerCase();
    const op = /^CREATE/i.test(m[1]) ? "create" : /^DROP/i.test(m[1]) ? "drop" : "alter";
    const end = m.index + m[0].length;
    let on = null;
    if (kind === "trigger" && op !== "drop") {
      const t = src.slice(end, end + 300).match(TRIGGER_ON_RE);
      const tn = t && splitName(t[1]);
      if (tn && isRealObject(tn) && tn.name !== "database" && tn.name !== "all") on = tn.name;
    }
    const next = bounds.find((b) => b > m.index) ?? src.length;
    routines.push({ kind, name: n.name, op, idx: m.index, bodyStart: end, bodyEnd: op === "drop" ? end : next, on });
  }
  return { src, routines };
}

/** Tables a routine body reads/writes and procedures it EXECs, with T-SQL aliases
 *  (UPDATE o ... FROM dbo.orders o), CTE names and temp objects resolved away. */
function routineBodyAccess(body) {
  const ctes = new Set([...body.matchAll(CTE_RE)].map((m) => m[1].toLowerCase()));
  const alias = new Map();
  const hits = [];
  for (const m of body.matchAll(BODY_READ_RE)) {
    const n = splitName(m[2]);
    if (m[3] && !ALIAS_STOP.has(m[3].toLowerCase())) alias.set(m[3].toLowerCase(), n.name);
    if (/^FROM$/i.test(m[1]) && /\bDELETE\s+$/i.test(body.slice(Math.max(0, m.index - 12), m.index))) continue;
    hits.push({ n, mode: "read", at: m.index });
  }
  for (const m of body.matchAll(BODY_WRITE_RE)) hits.push({ n: splitName(m[1]), mode: "write", at: m.index });
  for (const m of body.matchAll(BODY_EXEC_RE)) hits.push({ n: splitName(m[1]), mode: "exec", at: m.index });
  const out = [];
  for (const h of hits) {
    const n = h.mode !== "exec" && !h.n.schema && alias.has(h.n.name) ? { ...h.n, name: alias.get(h.n.name) } : h.n;
    if (!isRealObject(n) || ctes.has(n.name) || BODY_NOISE.has(n.name)) continue;
    if (h.mode === "exec") {
      if (!isSystemProc(n)) out.push({ table: `proc:${n.name}`, kind: "proc", mode: "exec", at: h.at });
    } else out.push({ table: n.name, kind: "sql", mode: h.mode, at: h.at });
  }
  return out;
}

/** Access rows from routine bodies in one schema file: [{table, kind, mode, line, detail}]. */
export function extractRoutineAccess(relpath, text) {
  const { src, routines } = parseRoutines(relpath, text);
  if (!routines.length) return [];
  const lineAt = makeLineAt(text);
  const out = [];
  const seen = new Set();
  const push = (row) => {
    const k = `${row.table}|${row.mode}|${row.detail}`;
    if (!seen.has(k)) { seen.add(k); out.push(row); }
  };
  for (const r of routines) {
    if (r.op === "drop") continue;
    const detail = r.kind === "trigger" ? `trigger:${r.name}${r.on ? ` on ${r.on}` : ""}` : `${r.kind}:${r.name}`;
    if (r.kind === "trigger" && r.on) push({ table: r.on, kind: "trigger", mode: "trigger", line: lineAt(r.idx), detail });
    for (const a of routineBodyAccess(src.slice(r.bodyStart, r.bodyEnd))) {
      if (a.table === (r.kind === "proc" ? `proc:${r.name}` : r.name)) continue; // recursion / self-reference
      push({ table: a.table, kind: a.kind, mode: a.mode, line: lineAt(r.bodyStart + a.at), detail });
    }
  }
  return out;
}

// ---------- Procedure call sites in application code ----------
const JDBC_CALL_RE = new RegExp(String.raw`\{\s*(?:\?\s*=\s*)?call\s+(${QNAME})`, "i");
const EXEC_LIT_RE = new RegExp(String.raw`^\s*EXEC(?:UTE)?\s+(?:@\w+\s*=\s*)?(${QNAME})(?=\s*(?:$|[@?:;(,]))`, "i");
const CALL_LIT_RE = new RegExp(String.raw`^\s*CALL\s+(${QNAME})\s*\(`, "i");
const STR_LIT_RE = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
const ARG = String.raw`("(?:[^"\\]|\\.)*"|[A-Za-z_][\w.]*)`;
const PROC_APIS = [
  [new RegExp(String.raw`\.withProcedureName\s*\(\s*${ARG}`, "g"), "proc", "SimpleJdbcCall"],
  [new RegExp(String.raw`\.withFunctionName\s*\(\s*${ARG}`, "g"), "function", "SimpleJdbcCall"],
  [new RegExp(String.raw`\bcreateStoredProcedureQuery\s*\(\s*${ARG}`, "g"), "proc", "createStoredProcedureQuery"],
  [new RegExp(String.raw`@Procedure\s*\(\s*(?:(?:procedureName|value)\s*=\s*)?${ARG}`, "g"), "proc", "@Procedure"],
  [new RegExp(String.raw`@NamedStoredProcedureQuery\s*\([^@]{0,300}?\bprocedureName\s*=\s*${ARG}`, "g"), "proc", "@NamedStoredProcedureQuery"],
  [new RegExp(String.raw`(?:\bsuper|:\s*StoredProcedure)\s*\(\s*[\w.]+\s*,\s*${ARG}`, "g"), "proc", "StoredProcedure"],
  [new RegExp(String.raw`\bprepareCall\s*\(\s*([A-Za-z_][\w.]*)`, "g"), "sql", "prepareCall"],
  [/\.callproc\s*\(\s*(["'])([\w.[\]]+)\1/g, "proc", "cursor.callproc"],
];
// @Procedure with no name binds the procedure named after the method
const PROCEDURE_BARE_RE = /@Procedure(?:\s*\(\s*\))?\s+(?:[\w<>[\],.?]+\s+)+?(\w+)\s*\(/g;
const MSSQL_EXECUTE_RE = /\.execute\s*\(\s*(["'`])([\w.[\]]+)\1\s*[,)]/g;
/** Cheap gate: does this file possibly call a stored procedure? */
export const PROC_HINT_RE = /Procedure|prepareCall|\{\s*(?:\?\s*=\s*)?call\b|\bEXEC(?:UTE)?\s|callproc|\bCALL\s|['"]mssql['"]/i;

/** Procedure names a SQL string invokes ({call x}, EXEC x, CALL x(...)). */
function procsInSql(sql) {
  const m = sql.match(JDBC_CALL_RE) ?? sql.match(EXEC_LIT_RE) ?? sql.match(CALL_LIT_RE);
  if (!m) return null;
  const n = splitName(m[1]);
  return isRealObject(n) && !isSystemProc(n) ? n : null;
}

function procCallSites(text, constants, lineAt) {
  const out = [];
  const resolve = (arg) => {
    if (arg.startsWith('"')) return arg.slice(1, -1);
    return constants.get(arg) ?? constants.get(arg.split(".").pop()) ?? null;
  };
  const add = (n, objKind, idx, detail) => {
    if (!n || !isRealObject(n) || isSystemProc(n)) return;
    out.push({ table: objKind === "function" ? n.name : `proc:${n.name}`, kind: "proc", mode: "exec", line: lineAt(idx), detail });
  };
  for (const m of text.matchAll(STR_LIT_RE)) {
    const s = m[1] ?? m[2] ?? m[3] ?? "";
    const n = s.length < 400 && procsInSql(s);
    if (n) add(n, "proc", m.index, /^\s*\{/.test(s) ? "{call}" : /^\s*CALL/i.test(s) ? "CALL" : "EXEC");
  }
  for (const [re, objKind, detail] of PROC_APIS) {
    for (const m of text.matchAll(re)) {
      if (detail === "StoredProcedure" && !/extends\s+StoredProcedure\b|:\s*StoredProcedure\s*\(/.test(text)) break;
      if (detail === "cursor.callproc") { add(splitName(m[2]), "proc", m.index, detail); continue; }
      const v = resolve(m[1]);
      if (!v) continue;
      if (objKind === "sql") { add(procsInSql(v), "proc", m.index, detail); continue; } // constant SQL handed to prepareCall
      add(splitName(v), objKind, m.index, detail);
    }
  }
  for (const m of text.matchAll(PROCEDURE_BARE_RE)) add(splitName(m[1]), "proc", m.index, "@Procedure(method name)");
  if (/(?:require\s*\(\s*|from\s+)['"]mssql['"]/.test(text)) {
    for (const m of text.matchAll(MSSQL_EXECUTE_RE)) add(splitName(m[2]), "proc", m.index, "mssql request.execute");
  }
  return out;
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
  const routineOps = relpath.endsWith(".xml") ? XML_ROUTINE_OPS : relpath.endsWith(".sql") ? [] : YAML_ROUTINE_OPS;
  for (const [re, op, ns] of routineOps) {
    for (const m of text.matchAll(re)) {
      const n = splitName(m[1].replace(/['"]/g, ""));
      if (isRealObject(n)) out.push({ table: ns + n.name, op, line: lineAt(m.index), changeset: csAt(m.index) });
    }
  }
  // raw SQL in .sql files and <sql> blocks (comment-blanked in .sql, so a
  // commented-out CREATE TABLE is not a definition)
  const src = relpath.endsWith(".sql") ? blankSqlComments(text) : text;
  for (const m of src.matchAll(SQL_DDL_RE)) {
    const n = splitName(m[2]);
    if (!isRealObject(n)) continue; // #temp / @table variables are not schema
    const op = /^CREATE/i.test(m[1]) ? "create" : /^DROP/i.test(m[1]) ? "drop" : "alter";
    out.push({ table: n.name, op, line: lineAt(m.index), changeset: csAt(m.index) ?? fileTag });
  }
  // procedures / views / functions (triggers: see extractRoutineAccess)
  for (const r of parseRoutines(relpath, text).routines) {
    if (r.kind === "trigger") continue;
    out.push({ table: r.kind === "proc" ? `proc:${r.name}` : r.name, op: `${r.op} ${r.kind}`, line: lineAt(r.idx), changeset: csAt(r.idx) ?? fileTag });
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
const SQL_TABLES_RE = new RegExp(String.raw`\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO)\s+(${QNAME})`, "gi");

const camelToSnake = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const SQL_KEYWORD_NOISE = new Set(["select", "dual", "values", "set", "where", "on"]);

function tablesFromSql(sql) {
  const tables = new Set();
  const isWrite = /^\s*(insert|update|delete|merge|truncate)/i.test(sql);
  for (const m of sql.matchAll(SQL_TABLES_RE)) {
    const n = splitName(m[1]);
    if (isRealObject(n) && !SQL_KEYWORD_NOISE.has(n.name)) tables.add(n.name);
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
  if (PROC_HINT_RE.test(text)) out.push(...procCallSites(text, new Map(), lineAt));
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
    const fromConstant = !sql.startsWith('"');
    if (fromConstant) sql = constants.get(sql) ?? "";
    else sql = sql.slice(1, -1);
    if (!sql) continue;
    // a constant's {call x}/EXEC x is credited here, at the call site; a literal
    // one is already credited by the string-literal scan in procCallSites
    const proc = fromConstant && procsInSql(sql);
    if (proc) out.push({ table: `proc:${proc.name}`, kind: "proc", mode: "exec", line: lineAt(m.index), detail: `JdbcTemplate.${m[1]}` });
    const { tables, mode } = tablesFromSql(sql);
    for (const t of tables) out.push({ table: t, kind: "sql", mode, line: lineAt(m.index), detail: `JdbcTemplate.${m[1]}` });
  }
  if (PROC_HINT_RE.test(text)) out.push(...procCallSites(text, constants, lineAt));
  // de-dup
  const seen = new Set();
  return out.filter((e) => {
    const k = `${e.table}|${e.kind}|${e.line}|${e.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
