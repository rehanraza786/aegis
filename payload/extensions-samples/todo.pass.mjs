/** Sample AEGIS extension (pass hook): scans tracked sources for TODO/FIXME
 * into a `todos` table. Drop into .ariadne/extensions/ to activate. */
export async function run({ db, tracked, readText, idByPath, inScope }) {
  db.exec("CREATE TABLE IF NOT EXISTS todos(file_id INTEGER, line INTEGER, text TEXT)");
  db.exec("DELETE FROM todos");
  const ins = db.prepare("INSERT INTO todos(file_id, line, text) VALUES(?,?,?)");
  for (const rel of tracked) {
    if (!/\.(java|kt|ts|tsx|js|jsx|py|md)$/.test(rel)) continue;
    const text = readText(rel);
    const fid = idByPath.get(rel)?.id ?? idByPath.get(rel);
    if (!text || !fid) continue;
    let n = 0;
    for (const line of text.split("\n")) {
      n++;
      const m = line.match(/(?:\/\/|#|\*)\s*(TODO|FIXME)[:\s](.{0,120})/);
      if (m) ins.run(typeof fid === "object" ? fid.id : fid, n, `${m[1]}: ${m[2].trim()}`);
    }
  }
}
