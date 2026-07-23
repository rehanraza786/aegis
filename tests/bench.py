#!/usr/bin/env python3
"""AEGIS indexer benchmark.

Generates a synthetic repo (Java services with Kafka/JPA/Liquibase, a TS web
app, a Python package, config + changelogs), runs the chosen edition against
it, and reports wall times for the paths that matter:

  full-cold      first --full over the repo (parse + extract + insert)
  full-warm      second --full (everything hits the unchanged fast path)
  incremental    --incremental after K files changed and committed

This is a harness, not a test: it asserts nothing beyond exit codes and prints
a table, so runs are comparable across machines and revisions. The row counts
are printed so a perf change that silently drops graph rows is visible.

Usage:
  python3 tests/bench.py --runtime node   [--files 1500] [--changed 60] [--keep]
  python3 tests/bench.py --runtime python [--files 1500] [--changed 60] [--keep]

The repo size knob is per-language-weighted: --files N yields roughly
0.6N Java, 0.2N TS, 0.15N Python, plus config/changelog/test files.
"""
import argparse
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

TOOLKIT = Path(__file__).resolve().parent.parent
py = sys.executable


def run(cmd, cwd, env=None):
    e = dict(os.environ)
    if env:
        e.update(env)
    cmd = list(cmd)
    if os.name == "nt":
        resolved = shutil.which(cmd[0])
        if resolved:
            cmd[0] = resolved
            if resolved.lower().endswith((".cmd", ".bat")):
                cmd = [os.environ.get("COMSPEC", "cmd.exe"), "/c"] + cmd
    r = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, env=e)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def git(args, cwd):
    return subprocess.run(["git", "-c", "user.email=b@b", "-c", "user.name=b"] + args,
                          cwd=str(cwd), capture_output=True, text=True)


def w(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


# ------------------------------------------------------------------ fixture

def java_service(i, n):
    """A service class with methods, a listener, a producer, and JPA access —
    enough to light up the symbol, call, kafka, and db extractors."""
    dep = (i + 1) % n
    methods = "\n".join(
        f"""    public String handle{j}(String arg{j}) {{
        log.info("handling {j}");
        return helper{j}(arg{j}) + repository.findAll().size();
    }}

    private String helper{j}(String s) {{
        return s.trim().toUpperCase();
    }}""" for j in range(6))
    return f"""package com.bench.svc{i};

import com.bench.svc{dep}.Service{dep};
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Service;

@Service
public class Service{i} {{
    private static final String TOPIC = "bench.svc{i}.events";
    private final BenchRepository{i} repository;
    private final Object log = null;

    @KafkaListener(topics = "${{bench.topics.svc{i}}}")
    public void onMessage(String payload) {{
        kafkaTemplate.send(TOPIC, payload);
        new Service{dep}().toString();
    }}

{methods}
}}
"""


def java_entity(i):
    return f"""package com.bench.svc{i};

import jakarta.persistence.Entity;
import jakarta.persistence.Table;

@Entity
@Table(name = "bench_items_{i % 20}")
public class BenchItem{i} {{
    private Long id;
    private String name;

    public Long getId() {{ return id; }}
    public String getName() {{ return name; }}
}}
"""


def java_test(i):
    cases = "\n".join(
        f"""    @Test
    void verifies{j}() {{
        Service{i} s = new Service{i}();
        s.handle{j % 6}("x");
    }}""" for j in range(4))
    return f"""package com.bench.svc{i};

import org.junit.jupiter.api.Test;

class Service{i}Test {{
{cases}
}}
"""


def ts_module(i, n):
    dep = (i + 1) % n
    fns = "\n".join(
        f"""export function transform{j}_{i}(input: string): string {{
  return input.split("").reverse().join("") + {j};
}}""" for j in range(5))
    return f"""import {{ transform0_{dep} }} from "./mod{dep}";

{fns}

export async function fetchThing{i}() {{
  const r = await fetch(`/api/bench/{i % 40}/items`);
  return r.json();
}}
"""


def py_module(i, n):
    dep = (i + 1) % n
    fns = "\n".join(
        f"""def process_{j}_{i}(value):
    return str(value).strip().lower() + "{j}"
""" for j in range(5))
    return f"""from pkg.mod{dep} import process_0_{dep}

{fns}

class Handler{i}:
    def run(self, value):
        return process_0_{i}(process_0_{dep}(value))
"""


def changelog_xml(n_changesets):
    sets = "\n".join(
        f"""  <changeSet id="{i}" author="bench">
    <createTable tableName="bench_items_{i}">
      <column name="id" type="bigint"/>
    </createTable>
    <addColumn tableName="bench_items_{i}">
      <column name="name" type="varchar(255)"/>
    </addColumn>
  </changeSet>""" for i in range(n_changesets))
    return f"""<?xml version="1.0"?>
<databaseChangeLog>
{sets}
</databaseChangeLog>
"""


def application_yml(n_topics):
    topics = "\n".join(f"    svc{i}: bench.svc{i}.events" for i in range(n_topics))
    return f"""bench:
  topics:
{topics}
spring:
  application:
    name: bench
"""


def make_repo(root: Path, n_files: int):
    n_java = max(3, int(n_files * 0.6))
    n_ts = max(2, int(n_files * 0.2))
    n_py = max(2, int(n_files * 0.15))
    for i in range(n_java):
        w(root / f"app/src/main/java/com/bench/svc{i}/Service{i}.java", java_service(i, n_java))
        if i % 3 == 0:
            w(root / f"app/src/main/java/com/bench/svc{i}/BenchItem{i}.java", java_entity(i))
        if i % 5 == 0:
            w(root / f"app/src/test/java/com/bench/svc{i}/Service{i}Test.java", java_test(i))
    for i in range(n_ts):
        w(root / f"web/src/mod{i}.ts", ts_module(i, n_ts))
    for i in range(n_py):
        w(root / f"py/pkg/mod{i}.py", py_module(i, n_py))
    w(root / "py/pkg/__init__.py", "")
    w(root / "app/src/main/resources/application.yml", application_yml(min(n_java, 200)))
    # one large changelog: this is the file where per-match line math used to go quadratic
    w(root / "app/src/main/resources/db/changelog/db.changelog-master.xml", changelog_xml(400))
    w(root / "README.md", "# bench fixture\n")
    git(["init", "-q", "-b", "main"], root)
    git(["add", "-A"], root)
    git(["commit", "-qm", "init"], root)


# ------------------------------------------------------------------ harness

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runtime", choices=["node", "python"], required=True)
    ap.add_argument("--files", type=int, default=1500, help="approximate source-file count")
    ap.add_argument("--changed", type=int, default=60, help="files touched before the incremental run")
    ap.add_argument("--keep", action="store_true", help="keep the temp repo for inspection")
    args = ap.parse_args()
    rt = args.runtime
    exe = ["node"] if rt == "node" else [py]

    tmp = Path(tempfile.mkdtemp(prefix="aegis-bench-"))
    ws = tmp / "repo"
    ws.mkdir()
    print(f"== bench repo: {ws} ({args.files} files, runtime={rt})")
    t0 = time.perf_counter()
    make_repo(ws, args.files)
    print(f"   fixture generated in {time.perf_counter() - t0:.1f}s")

    ar = ws / ".ariadne"
    shutil.copytree(TOOLKIT / "payload" / f"ariadne-{rt}", ar)
    if rt == "node":
        code, out = run(["npm", "install", "--no-audit", "--no-fund", "--silent"], ar)
        if code != 0:
            print("npm install failed:\n" + out[-800:])
            sys.exit(1)
    else:
        # the indexer itself is stdlib; tree-sitter makes the AST path realistic
        run([py, "-m", "pip", "install", "-q", "--break-system-packages",
             "tree-sitter", "tree-sitter-language-pack<1"], ws)
    idx = str(ar / ("indexer.mjs" if rt == "node" else "indexer.py"))

    timings = {}

    def bench(label, argv):
        t = time.perf_counter()
        code, out = run(exe + [idx] + argv, ws)
        timings[label] = time.perf_counter() - t
        if code != 0:
            print(f"{label} FAILED:\n" + out[-800:])
            sys.exit(1)

    bench("full-cold", ["--full"])
    bench("full-warm", ["--full"])

    # touch K files (real content change so hashes move) and commit
    n_java = max(3, int(args.files * 0.6))
    for i in range(min(args.changed, n_java)):
        f = ws / f"app/src/main/java/com/bench/svc{i}/Service{i}.java"
        f.write_text(f.read_text(encoding="utf-8") + f"\n// bench touch {i}\n", encoding="utf-8")
    git(["add", "-A"], ws)
    git(["commit", "-qm", "touch"], ws)
    bench("incremental", ["--incremental"])

    db = sqlite3.connect(ar / "index.db")
    q = lambda sql: db.execute(sql).fetchone()[0]
    print(f"\n   rows: files={q('SELECT COUNT(*) FROM files')} symbols={q('SELECT COUNT(*) FROM symbols')} "
          f"calls={q('SELECT COUNT(*) FROM calls')} edges={q('SELECT COUNT(*) FROM edges')} "
          f"msg={q('SELECT COUNT(*) FROM msg_edges')} db_defs={q('SELECT COUNT(*) FROM db_defs')} "
          f"chunks={q('SELECT COUNT(*) FROM chunks')}")
    db.close()

    print(f"\n   {'phase':<14}{'seconds':>9}")
    for label, secs in timings.items():
        print(f"   {label:<14}{secs:>9.2f}")

    if args.keep:
        print(f"\n   kept: {ws}")
    else:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
