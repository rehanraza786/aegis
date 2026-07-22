#!/usr/bin/env python3
"""AEGIS self-test suite.

Builds a fixture workspace (6 git repos: Spring services with Kafka/Liquibase/
Lombok, a React frontend, a docs repo with an ADR and a PDF), runs the chosen
Ariadne edition against it, and asserts the graph, caching, scoping, and docgen
behavior. Pure stdlib except for the edition's own dependencies.

Usage:  python3 tests/run_tests.py --runtime node|python
Exit code 0 = all green. Designed for the GitHub Actions matrix (linux+windows).
"""
import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

TOOLKIT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"
FAILURES = []
# Use the exact interpreter running this harness for child Python processes
# rather than a literal "python3"/"python" that may not be on PATH (Windows).
py = sys.executable


def check(name, cond, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


def run(cmd, cwd, env=None):
    e = dict(os.environ)
    if env:
        e.update(env)
    cmd = list(cmd)
    if os.name == "nt":
        # Windows has no npm.exe (only npm.cmd), and CreateProcess only appends
        # ".exe" for a bare name -- so a plain "npm" is never found. Resolve the
        # real path via PATHEXT, and launch .cmd/.bat shims through COMSPEC since
        # CreateProcess cannot execute batch files directly.
        resolved = shutil.which(cmd[0])
        if resolved:
            cmd[0] = resolved
            if resolved.lower().endswith((".cmd", ".bat")):
                cmd = [os.environ.get("COMSPEC", "cmd.exe"), "/c"] + cmd
    r = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, env=e)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def pip_install(pkgs, cwd):
    code, out = run([py, "-m", "pip", "install", "-q"] + pkgs, cwd)
    if code != 0:  # PEP 668 externally-managed environments (some sandboxes/distros)
        code, out = run([py, "-m", "pip", "install", "-q", "--break-system-packages"] + pkgs, cwd)
    return code, out


def git(args, cwd):
    return subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t"] + args,
                          cwd=str(cwd), capture_output=True, text=True)


def w(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def install_sample_extensions(ws: Path, rt: str):
    ext = ws / ".ariadne" / "extensions"
    ext.mkdir(parents=True, exist_ok=True)
    suffix = ".mjs" if rt == "node" else ".py"
    for name in (f"todo.pass{suffix}", f"todo.tool{suffix}", f"spring-cloud-stream.extract{suffix}"):
        shutil.copy(TOOLKIT / "payload" / "extensions-samples" / name, ext / name)


def make_fixture(ws: Path):
    # ---- order-service: controller + publisher + Lombok entity + XML changelog ----
    o = ws / "order-service"
    w(o / "src/main/java/com/acme/OrderController.java", """package com.acme;
@RestController
@RequestMapping("/api/orders")
public class OrderController {
  @GetMapping
  public List<Order> list() { return svc.all(); }
  @GetMapping("/{id}")
  public Order get(@PathVariable Long id) { return svc.byId(id); }
  @DeleteMapping("/{id}")
  public void purge(@PathVariable Long id) { svc.purge(id); }
}
""")
    w(o / "src/main/java/com/acme/OrderPublisher.java", """package com.acme;
public class OrderPublisher {
  private static final String ORDERS_TOPIC = "orders.created";
  private final KafkaTemplate<String, Order> kafkaTemplate;
  public void publish(Order x) { kafkaTemplate.send(ORDERS_TOPIC, x.id(), x); }
}
""")
    w(o / "src/main/java/com/acme/PaymentEntity.java", """package com.acme;
import lombok.*;

@Table(name = "payments")
@Entity
@Getter
@Setter
@Builder
@NoArgsConstructor
public class PaymentEntity {
    @Id
    private Long id;
    private java.math.BigDecimal amount;
    private boolean reconciled;
    private static final String UNUSED_CONST = "skip";
}
""")
    w(o / "src/main/resources/db/changelog/001-orders.xml", """<databaseChangeLog>
  <changeSet id="001" author="alice">
    <createTable tableName="orders"><column name="id" type="bigint"/></createTable>
  </changeSet>
</databaseChangeLog>
""")
    w(o / "src/main/resources/application.yaml", "app:\n  kafka:\n    payments-topic: payments.completed\n")

    # ---- billing-service: listener + placeholder producer + dao + SQL changelog ----
    b = ws / "billing-service"
    w(b / "src/main/java/com/acme/BillingListener.java", """package com.acme;
public class BillingListener {
  @KafkaListener(topics = "orders.created", groupId = "billing")
  public void onOrder(Order o) { charge(o); }
  private final KafkaTemplate<String, Payment> template;
  public void completed(Payment p) { template.send("${app.kafka.payments-topic}", p); }
}
""")
    w(b / "src/main/java/com/acme/PaymentDao.java", """package com.acme;
public class PaymentDao {
  private final JdbcTemplate jdbcTemplate;
  public int legacyCount() { return jdbcTemplate.queryForObject("SELECT count(*) FROM legacy_invoices", Integer.class); }
}
""")
    w(b / "src/main/resources/db/changelog/010-payments.sql", """--liquibase formatted sql
--changeset carol:010
CREATE TABLE payments (id BIGINT PRIMARY KEY, order_id BIGINT);
""")
    w(b / "src/main/resources/application.yaml", "app:\n  kafka:\n    payments-topic: payments.completed\n")

    # ---- web-app: axios/fetch clients ----
    f = ws / "web-app"
    w(f / "src/api/orders.ts", """import axios from "axios";
export const listOrders = () => axios.get("/api/orders");
export const getOrder = (id: number) => axios.get(`/api/orders/${id}`);
export const legacy = () => fetch("/api/v1/reports");
// TODO: wire retry logic here
""")

    # ---- stream-service: Spring Cloud Stream bindings + Kotlin + Gradle ----
    s = ws / "stream-service"
    w(s / "src/main/java/com/acme/StreamHandlers.java", """package com.acme;
public class StreamHandlers {
  @Bean public Consumer<Order> orders() { return o -> process(o); }
  @Bean public Supplier<Note> notify() { return () -> next(); }
}
""")
    w(s / "src/main/kotlin/com/acme/OrderHandler.kt", """class OrderHandler(private val repo: Repo) {
  fun handle(id: Long): Order { return repo.find(id) }
}
""")
    w(s / "src/main/resources/application.yaml", """spring:
  cloud:
    stream:
      bindings:
        orders-in-0:
          destination: stream.orders
        notify-out-0:
          destination: stream.notify
""")
    w(s / "build.gradle", "plugins { id 'java' }\ndependencies { implementation 'org.springframework.cloud:spring-cloud-stream' }\n")

    # ---- a genuinely dynamic topic: the parser CANNOT resolve this, by construction ----
    w(o / "src/main/java/com/acme/DynamicPublisher.java", """package com.acme;
public class DynamicPublisher {
  private final KafkaTemplate<String, Object> kafkaTemplate;
  private static final String PREFIX = "orders.created";
  public void publish(Object o, String env) {
    kafkaTemplate.send(PREFIX + "." + env, o);
  }
}
""")

    # ---- scale-service: enough topics/tables/endpoints to trip the summary thresholds ----
    sc = ws / "scale-service"
    prod = ["package com.acme;", "public class Bulk {", "  private final KafkaTemplate<String,Object> kafkaTemplate;"]
    cons = ["package com.acme;", "public class BulkC {"]
    for i in range(50):
        prod.append(f'  public void p{i}(Object o) {{ kafkaTemplate.send("bulk.t{i:02d}", o); }}')
        cons.append(f'  @KafkaListener(topics = "bulk.t{i:02d}")\n  public void c{i}(Object o) {{ h(o); }}')
    for i in range(7):  # orphan producers, must survive truncation
        prod.append(f'  public void op{i}(Object o) {{ kafkaTemplate.send("bulk.orphan{i}", o); }}')
    prod.append("}")
    cons.append("}")
    w(sc / "src/main/java/com/acme/Bulk.java", "\n".join(prod))
    w(sc / "src/main/java/com/acme/BulkC.java", "\n".join(cons))
    cl = ["<databaseChangeLog>"]
    for i in range(65):
        cl.append(f'  <changeSet id="s{i}" author="dev"><createTable tableName="bt_{i:02d}">'
                  f'<column name="id" type="bigint"/></createTable></changeSet>')
    cl.append("</databaseChangeLog>")
    w(sc / "src/main/resources/db/changelog/bulk.xml", "\n".join(cl))
    dao = ["package com.acme;", "public class BulkDao {", "  private final JdbcTemplate jdbcTemplate;"]
    for i in range(65):
        dao.append(f'  public int q{i}() {{ return jdbcTemplate.queryForObject("SELECT count(*) FROM bt_{i:02d}", Integer.class); }}')
    for i in range(3):  # DRIFT, must survive truncation
        dao.append(f'  public int d{i}() {{ return jdbcTemplate.queryForObject("SELECT count(*) FROM bulk_drift{i}", Integer.class); }}')
    dao.append("}")
    w(sc / "src/main/java/com/acme/BulkDao.java", "\n".join(dao))
    ctl = ["package com.acme;", "@RestController", '@RequestMapping("/bulk")', "public class BulkCtl {"]
    for i in range(60):
        ctl.append(f'  @GetMapping("/r{i:02d}")\n  public Object r{i}() {{ return s.g({i}); }}')
    ctl.append("}")
    w(sc / "src/main/java/com/acme/BulkCtl.java", "\n".join(ctl))

    # ---- docs-repo: ADR + PDF ----
    d = ws / "docs-repo"
    w(d / "adr/ADR-007.md", """# ADR-007: All inter-service communication via Kafka

Status: Accepted
Date: 2026-03-10

## Decision

Services MUST NOT call each other over HTTP; all flows use Kafka topics such as orders.created.
""")
    w(d / "adr/ADR-012.md", """# ADR-012: Allow synchronous HTTP for read-only queries

Status: Accepted
Date: 2026-06-01
Supersedes: ADR-007

## Decision

Commands stay on Kafka (orders.created); read-only queries MAY use HTTP. The payments table stays billing-owned.
""")
    (d / "spec.pdf").parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(FIXTURES / "spec.pdf", d / "spec.pdf")

    # ---- test code: one file per detection rule; the exact-count checks above double as leak guards ----
    w(o / "src/test/java/com/acme/OrderPublisherTest.java", """package com.acme;
import com.acme.OrderPublisher;
public class OrderPublisherTest {
  private static final String ORDERS_TOPIC = "test.orders";   // decoy: collides by NAME with prod constant
  private final KafkaTemplate<String, Order> kafkaTemplate;
  @Test void shouldPublishOrderCreatedEvent() { kafkaTemplate.send(ORDERS_TOPIC, new Order()); new OrderPublisher().publish(null); }
  @Test void shouldNotPublishWhenOrderInvalid() { }
  @KafkaListener(topics = "orders.deadletter") public void onDeadletter(Order o) { }
}
""")
    w(sc / "src/test/java/com/acme/OrphanConsumerIT.java", """package com.acme;
public class OrphanConsumerIT { @KafkaListener(topics = "bulk.orphan0") public void onOrphan(String m) { } }
""")
    w(b / "src/test/java/com/acme/PaymentDaoTest.java", """package com.acme;
public class PaymentDaoTest { @Test void shouldCountScratchRows() { jdbcTemplate.queryForObject("SELECT count(*) FROM test_scratch", Integer.class); } }
""")
    w(f / "src/api/__tests__/orders.spec.ts", """import axios from "axios";
const id = 123;
describe("orders api", () => { it("fetches orders by id", async () => { await axios.get(`/api/orders/${id}`); await axios.post("/internal/testing/reset"); }); });
""")
    w(f / "scripts/test_smoke.py", "def test_ping():\n    assert True\n")

    for repo in (o, b, f, s, sc, d):
        git(["init", "-q"], repo)
        git(["add", "-A"], repo)
        git(["commit", "-qm", "init"], repo)

    # ---- feature artifacts for PROGRESS ----
    w(ws / "docs/features/001-payment-flow/tasks.md",
      "- [x] **T001** a\n- [x] **T002** b\n- [~] **T003** c\n- [ ] **T004** d\n- [!] **T005** e\n")
    w(ws / "docs/features/001-payment-flow/spec.md", "- **FR-001**: x\n- **FR-002**: [NEEDS CLARIFICATION: y]\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runtime", choices=["node", "python"], required=True)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()
    rt = args.runtime
    exe = ["node"] if rt == "node" else [py]

    tmp = Path(tempfile.mkdtemp(prefix="aegis-test-"))
    ws = tmp / "ws"
    ws.mkdir()
    print(f"== fixture: {ws}")
    make_fixture(ws)

    ar = ws / ".ariadne"
    shutil.copytree(TOOLKIT / "payload" / f"ariadne-{rt}", ar)
    if rt == "node":
        code, out = run(["npm", "install", "--no-audit", "--no-fund", "--silent"], ar)
        check("npm install", code == 0, out[-400:])
        # The SCIP fixture below is built with Python's protobuf (scip_pb2) no
        # matter which runtime is under test, so protobuf must be present here too.
        # scip_pb2.py is gencode 7.35; the runtime must be at least that new, and a
        # bare "protobuf" is satisfied by any preinstalled older copy (e.g. Anaconda
        # ships 5.x), which then dies with VersionError at import.
        code, out = pip_install(["protobuf>=7.35"], ws)
        check("pip install (protobuf fixture dep)", code == 0, out[-400:])
    else:
        # Install from the edition's own requirements.txt rather than a hand-kept
        # list, so the test environment can never drift from the real deps (this
        # is what silently dropped `mcp`, which server.py imports).
        req = TOOLKIT / "payload" / "ariadne-python" / "requirements.txt"
        code, out = pip_install(["-r", str(req)], ws)
        check("pip install", code == 0, out[-400:])

    install_sample_extensions(ws, rt)
    idx = str(ar / ("indexer.mjs" if rt == "node" else "indexer.py"))

    # ---- full index ----
    code, out1 = run(exe + [idx, "--full"], ws)
    check("full index exits 0", code == 0, out1[-600:])

    db = sqlite3.connect(ws / ".ariadne" / "index.db")
    q = lambda sql, *a: db.execute(sql, a).fetchall()

    # graph layers
    check("workspace mode (6 repos)", "Workspace mode: 6 repos" in out1)
    check("AST nesting (OrderController.list)",
          q("SELECT 1 FROM symbols WHERE name='list' AND parent='OrderController'") != [])
    check("Lombok synthesis (isReconciled)",
          q("SELECT 1 FROM symbols WHERE name='isReconciled' AND parent='PaymentEntity'") != [])
    check("Lombok builder", q("SELECT 1 FROM symbols WHERE name='builder' AND parent='PaymentEntity'") != [])
    check("Lombok skips static-final", q("SELECT 1 FROM symbols WHERE name LIKE 'getUnused%'") == [])
    check("entity @Table-before-@Entity",
          q("SELECT 1 FROM db_access WHERE detail='PaymentEntity' AND tbl='payments'") != [])
    check("kafka cross-repo (orders.created 1p+1c)",
          len(q("SELECT DISTINCT direction FROM msg_edges WHERE topic='orders.created'")) == 2)
    check("kafka yaml placeholder (payments.completed)",
          q("SELECT 1 FROM msg_edges WHERE topic='payments.completed' AND via LIKE '%payments-topic%'") != [])
    check("liquibase changeset tagged",
          q("SELECT 1 FROM db_defs WHERE tbl='orders' AND changeset='alice:001'") != [])
    check("db drift (legacy_invoices)",
          q("SELECT 1 FROM db_access WHERE tbl='legacy_invoices'") != [] and
          q("SELECT 1 FROM db_defs WHERE tbl='legacy_invoices'") == [])
    check("http endpoint extracted",
          q("SELECT 1 FROM http_endpoints WHERE method='GET' AND norm='/api/orders/{}'") != [])
    check("http caller matched (web-app axios)",
          q("SELECT 1 FROM http_calls WHERE norm='/api/orders/{}' AND client='axios'") != [])
    check("pdf indexed into FTS",
          q("SELECT 1 FROM chunks WHERE path LIKE '%spec.pdf' LIMIT 1") != [])
    check("kotlin AST nesting (OrderHandler.handle)",
          q("SELECT 1 FROM symbols WHERE name='handle' AND parent='OrderHandler'") != [])
    check("gradle build file indexed",
          q("SELECT 1 FROM files WHERE path LIKE '%build.gradle'") != [])
    check("extractor plugin: stream binding consume",
          q("SELECT 1 FROM msg_edges WHERE topic='stream.orders' AND direction='consume' AND via LIKE '%orders-in-0%'") != [])
    check("extractor plugin: stream binding produce",
          q("SELECT 1 FROM msg_edges WHERE topic='stream.notify' AND direction='produce'") != [])
    # test awareness: is_test says WHERE code lives, source says WHO derived the fact
    check("test file flagged (java src/test + Test suffix)",
          q("SELECT 1 FROM files WHERE path LIKE '%OrderPublisherTest.java' AND is_test=1") != [])
    check("test file flagged (java IT suffix)",
          q("SELECT 1 FROM files WHERE path LIKE '%OrphanConsumerIT.java' AND is_test=1") != [])
    check("test file flagged (ts __tests__/.spec)",
          q("SELECT 1 FROM files WHERE path LIKE '%orders.spec.ts' AND is_test=1") != [])
    check("test file flagged (py test_ prefix)",
          q("SELECT 1 FROM files WHERE path LIKE '%test_smoke.py' AND is_test=1") != [])
    check("prod file not flagged",
          q("SELECT 1 FROM files WHERE path LIKE '%OrderPublisher.java' AND is_test=0") != [])
    check("test kafka fact kept, source stays 'static'",
          q("SELECT 1 FROM msg_edges m JOIN files f ON f.id=m.file_id WHERE m.topic='test.orders' AND f.is_test=1 AND m.source='static'") != [])
    check("test constant resolves via own file, never the global prod map",
          q("SELECT 1 FROM msg_edges m JOIN files f ON f.id=m.file_id WHERE f.path LIKE '%OrderPublisherTest.java' AND m.topic='orders.created'") == [])
    check("test consumer edge kept (bulk.orphan0)",
          q("SELECT 1 FROM msg_edges m JOIN files f ON f.id=m.file_id WHERE m.topic='bulk.orphan0' AND m.direction='consume' AND f.is_test=1") != [])
    check("test db access kept (test_scratch)",
          q("SELECT 1 FROM db_access a JOIN files f ON f.id=a.file_id WHERE a.tbl='test_scratch' AND f.is_test=1") != [])
    check("test http call kept (/api/orders/{})",
          q("SELECT 1 FROM http_calls c JOIN files f ON f.id=c.file_id WHERE c.norm='/api/orders/{}' AND f.is_test=1") != [])
    check("test case extracted (java @Test)",
          q("SELECT 1 FROM test_cases WHERE name='shouldPublishOrderCreatedEvent'") != [])
    check("test case extracted (jest string)",
          q("SELECT 1 FROM test_cases WHERE name='fetches orders by id'") != [])
    check("test case extracted (python def)",
          q("SELECT 1 FROM test_cases WHERE name='test_ping'") != [])
    check("no test cases from prod files",
          q("SELECT 1 FROM test_cases tc JOIN files f ON f.id=tc.file_id WHERE f.is_test=0") == [])
    db.close()

    # ---- Mnemosyne decision memory ----
    db = sqlite3.connect(ws / ".ariadne" / "index.db")
    check("decisions extracted", db.execute("SELECT COUNT(*) FROM decisions").fetchone()[0] >= 2)
    row = db.execute("SELECT status, valid_until, superseded_by FROM decisions WHERE id='ADR-007'").fetchone()
    check("temporal supersession chain", row is not None and row[0] == "superseded"
          and row[1] == "2026-06-01" and row[2] == "ADR-012", str(row))
    check("decision links cross-referenced against graph",
          db.execute("SELECT 1 FROM decision_links WHERE decision_id='ADR-012' AND kind='topic' AND target='orders.created'").fetchone() is not None)
    db.close()

    # ---- caching ----
    code, out2 = run(exe + [idx, "--full"], ws)
    check("second full all cached", re.search(r"0 \(re\)indexed", out2) is not None, out2[-300:])
    adr = ws / "docs-repo" / "adr" / "ADR-007.md"
    adr.write_text(adr.read_text() + "\nchanged\n")
    code, out3 = run(exe + [idx, "--full"], ws)
    check("changed md reindexes exactly 1", re.search(r"1 \(re\)indexed", out3) is not None, out3[-300:])
    pdf = ws / "docs-repo" / "spec.pdf"
    os.utime(pdf, None)
    code, out4 = run(exe + [idx, "--full"], ws)
    check("touched pdf not reprocessed", re.search(r"0 \(re\)indexed", out4) is not None, out4[-300:])

    # ---- scoped passes on incremental ----
    dao = ws / "billing-service" / "src/main/java/com/acme/PaymentDao.java"
    dao.write_text(dao.read_text() + "// touched\n")
    git(["add", "-A"], ws / "billing-service")
    git(["commit", "-qm", "t"], ws / "billing-service")
    code, out5 = run(exe + [idx, "--incremental"], ws)
    check("incremental picks 1 change", "1 changed" in out5, out5[-300:])
    check("correlation passes are scoped, not global",
          re.search(r"Extraction scoped to \d+/\d+ changed files", out5) is not None, out5[-300:])
    db = sqlite3.connect(ws / ".ariadne" / "index.db")
    check("cross-repo data intact after scoped pass",
          db.execute("SELECT COUNT(*) FROM msg_edges WHERE topic='orders.created'").fetchone()[0] == 2)
    db.close()

    # ---- test classification survives the incremental path ----
    db = sqlite3.connect(ws / ".ariadne" / "index.db")
    n_tst = db.execute("SELECT COUNT(*) FROM msg_edges WHERE topic='test.orders'").fetchone()[0]
    db.close()
    tst = ws / "order-service" / "src/test/java/com/acme/OrderPublisherTest.java"
    tst.write_text(tst.read_text() + "// touched\n")
    git(["add", "-A"], ws / "order-service")
    git(["commit", "-qm", "t"], ws / "order-service")
    code, ot = run(exe + [idx, "--incremental"], ws)
    check("incremental picks changed test file", "1 changed" in ot, ot[-300:])
    db = sqlite3.connect(ws / ".ariadne" / "index.db")
    check("is_test survives reindex",
          db.execute("SELECT is_test FROM files WHERE path LIKE '%OrderPublisherTest.java'").fetchone()[0] == 1)
    check("test edge count unchanged by incremental",
          db.execute("SELECT COUNT(*) FROM msg_edges WHERE topic='test.orders'").fetchone()[0] == n_tst)
    db.close()

    # ---- context budget at scale: summaries, warning survival, hard byte cap ----
    if rt == "node":
        probe = ws / ".ariadne" / "_scale.mjs"
        probe.write_text("""import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t = new StdioClientTransport({ command: "node", args: [".ariadne/server.mjs"], cwd: process.cwd() });
const c = new Client({ name: "s", version: "1" });
await c.connect(t);
const call = async (n, a = {}) => (await c.callTool({ name: n, arguments: a })).content[0].text;
const mf = await call("message_flow"), dm = await call("db_map"), hm = await call("http_map");
const bo = JSON.parse(await call("message_flow", { topic: "bulk.orphan0" }))[0];
const tu = ((bo.test_usage || {}).consumers || [""])[0];
const tun = JSON.parse(await call("http_map", { path: "/internal/testing" }));
const out = { mf: mf.length, dm: dm.length, hm: hm.length,
  orphans: JSON.parse(mf).warnings.produced_but_never_consumed.length,
  drift: JSON.parse(dm).warnings.DRIFT_accessed_but_no_changeset.length,
  scoped: (await call("message_flow", { topic: "bulk.t07" })).includes("Bulk.java"),
  testOnly: (JSON.parse(mf).warnings.topics_only_exercised_by_tests || []).includes("test.orders"),
  driftClean: !JSON.parse(dm).warnings.DRIFT_accessed_but_no_changeset.includes("test_scratch"),
  testAcc: (JSON.parse(dm).warnings.accessed_only_by_tests || []).includes("test_scratch"),
  orphanProd: bo.producers.some((p) => p.includes("Bulk.java")) && bo.consumers.length === 0,
  orphanWarn: (bo.warning || "").includes("produced but no consumer"),
  orphanTest: tu.includes("OrphanConsumerIT") && tu.includes("[TEST]"),
  dmProd: JSON.parse(dm).summary.includes("more only in tests"),
  testUnmatched: tun.some((x) => (x.test_unmatched_calls || []).some((s) => s.includes("orders.spec.ts") && s.includes("[TEST]")))
    && !tun.some((x) => (x.unmatched_calls || []).some((s) => s.includes("/internal/testing"))) };
console.log("SCALE:" + JSON.stringify(out));
await c.close();
""")
        code, osc2 = run(["node", str(probe)], ws)
        probe.unlink(missing_ok=True)
        m = re.search(r"SCALE:(\{.*\})", osc2)
        import json as _j
        sc_res = _j.loads(m.group(1)) if m else {}
        check("no-arg message_flow summarized, not dumped (<4KB)", 0 < sc_res.get("mf", 1e9) < 4000, str(sc_res.get("mf")))
        check("no-arg db_map summarized (<4KB)", 0 < sc_res.get("dm", 1e9) < 4000, str(sc_res.get("dm")))
        check("no-arg http_map summarized (<4KB)", 0 < sc_res.get("hm", 1e9) < 4000, str(sc_res.get("hm")))
        check("orphan topics survive truncation", sc_res.get("orphans", 0) >= 7, str(sc_res.get("orphans")))
        check("DRIFT tables survive truncation", sc_res.get("drift", 0) >= 3, str(sc_res.get("drift")))
        check("scoped query still returns full detail", sc_res.get("scoped") is True)
        check("test-only topic reported as warning, not topology", sc_res.get("testOnly") is True, str(sc_res))
        check("DRIFT list free of test-only tables", sc_res.get("driftClean") is True)
        check("test-only table gets its own warning", sc_res.get("testAcc") is True)
        check("orphan detail keeps prod-only producers/consumers", sc_res.get("orphanProd") is True)
        check("test consumer does not cure the orphan warning", sc_res.get("orphanWarn") is True)
        check("test consumer routed to test_usage, labeled [TEST]", sc_res.get("orphanTest") is True)
        check("db_map headline counts production tables only", sc_res.get("dmProd") is True)
        check("test-only external call listed and labeled, never a warning", sc_res.get("testUnmatched") is True)
    else:
        code, osc2 = run([py, "-c",
            "import sys, os, json; os.chdir(r'" + str(ws) + "'); sys.path.insert(0, r'" + str(ar) + "'); "
            "import server; mf=server.message_flow(); dm=server.db_map(); hm=server.http_map(); "
            "bo=json.loads(server.message_flow(topic='bulk.orphan0'))[0]; "
            "tu=bo.get('test_usage', {}).get('consumers', [''])[0]; "
            "tun=json.loads(server.http_map(path='/internal/testing')); "
            "print('SCALE:' + json.dumps({'mf': len(mf), 'dm': len(dm), 'hm': len(hm), "
            "'orphans': len(json.loads(mf)['warnings']['produced_but_never_consumed']), "
            "'drift': len(json.loads(dm)['warnings']['DRIFT_accessed_but_no_changeset']), "
            "'scoped': 'Bulk.java' in server.message_flow(topic='bulk.t07'), "
            "'testOnly': 'test.orders' in json.loads(mf)['warnings'].get('topics_only_exercised_by_tests', []), "
            "'driftClean': 'test_scratch' not in json.loads(dm)['warnings']['DRIFT_accessed_but_no_changeset'], "
            "'testAcc': 'test_scratch' in json.loads(dm)['warnings'].get('accessed_only_by_tests', []), "
            "'orphanProd': any('Bulk.java' in p for p in bo['producers']) and bo['consumers'] == [], "
            "'orphanWarn': 'produced but no consumer' in bo.get('warning', ''), "
            "'orphanTest': 'OrphanConsumerIT' in tu and '[TEST]' in tu, "
            "'dmProd': 'more only in tests' in json.loads(dm)['summary'], "
            "'testUnmatched': any('orders.spec.ts' in s and '[TEST]' in s for x in tun for s in x.get('test_unmatched_calls', [])) "
            "and not any('/internal/testing' in s for x in tun for s in x.get('unmatched_calls', []))}))"], ws)
        m = re.search(r"SCALE:(\{.*\})", osc2)
        import json as _j
        sc_res = _j.loads(m.group(1)) if m else {}
        check("no-arg message_flow summarized, not dumped (<4KB)", 0 < sc_res.get("mf", 1e9) < 4000, osc2[-200:])
        check("no-arg db_map summarized (<4KB)", 0 < sc_res.get("dm", 1e9) < 4000)
        check("no-arg http_map summarized (<4KB)", 0 < sc_res.get("hm", 1e9) < 4000)
        check("orphan topics survive truncation", sc_res.get("orphans", 0) >= 7)
        check("DRIFT tables survive truncation", sc_res.get("drift", 0) >= 3)
        check("scoped query still returns full detail", sc_res.get("scoped") is True)
        check("test-only topic reported as warning, not topology", sc_res.get("testOnly") is True, str(sc_res))
        check("DRIFT list free of test-only tables", sc_res.get("driftClean") is True)
        check("test-only table gets its own warning", sc_res.get("testAcc") is True)
        check("orphan detail keeps prod-only producers/consumers", sc_res.get("orphanProd") is True)
        check("test consumer does not cure the orphan warning", sc_res.get("orphanWarn") is True)
        check("test consumer routed to test_usage, labeled [TEST]", sc_res.get("orphanTest") is True)
        check("db_map headline counts production tables only", sc_res.get("dmProd") is True)
        check("test-only external call listed and labeled, never a warning", sc_res.get("testUnmatched") is True)

    # ---- performance: extraction is scoped to changed FILES, and loses no rows ----
    before = sqlite3.connect(ws / ".ariadne" / "index.db")
    n_msg = before.execute("SELECT COUNT(*) FROM msg_edges").fetchone()[0]
    n_acc = before.execute("SELECT COUNT(*) FROM db_access").fetchone()[0]
    before.close()
    bulk = ws / "scale-service" / "src/main/java/com/acme/Bulk.java"
    bulk.write_text(bulk.read_text() + "// touched\n")
    git(["add", "-A"], ws / "scale-service")
    git(["commit", "-qm", "perf"], ws / "scale-service")
    code, op2 = run(exe + [idx, "--incremental"], ws)
    check("extraction scoped to changed files only",
          re.search(r"Extraction scoped to \d+/\d+ changed files", op2) is not None, op2[-200:])
    after = sqlite3.connect(ws / ".ariadne" / "index.db")
    check("scoped extraction loses no correlation rows",
          after.execute("SELECT COUNT(*) FROM msg_edges").fetchone()[0] == n_msg
          and after.execute("SELECT COUNT(*) FROM db_access").fetchone()[0] == n_acc,
          f"msg {n_msg}, acc {n_acc}")
    after.close()

    # ---- context_pack: one call, focused, budgeted ----
    if rt == "node":
        cp = ws / ".ariadne" / "_cp.mjs"
        cp.write_text("""import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t = new StdioClientTransport({ command: "node", args: [".ariadne/server.mjs"], cwd: process.cwd() });
const c = new Client({ name: "cp", version: "1" });
await c.connect(t);
const r = (await c.callTool({ name: "context_pack", arguments: { target: "OrderPublisher" } })).content[0].text;
const o = JSON.parse(r);
const ts = typeof o.tests === "object" && o.tests !== null ? o.tests : { files: [], behaviors: [] };
console.log("CP:" + JSON.stringify({ size: r.length, kafka: Array.isArray(o.kafka) ? o.kafka.length : 0,
  hasOutline: (o.outline || []).length > 0, gov: Array.isArray(o.governing_decisions) ? o.governing_decisions.length : 0,
  tests: ts.files.some((f) => f.includes("OrderPublisherTest.java")) && ts.behaviors.includes("should publish order created event") }));
await c.close();
""")
        code, ocp = run(["node", str(cp)], ws)
        cp.unlink(missing_ok=True)
        m2 = re.search(r"CP:(\{.*\})", ocp)
        import json as _j3
        cp_res = _j3.loads(m2.group(1)) if m2 else {}
        check("context_pack returns focused bundle", cp_res.get("hasOutline") is True and cp_res.get("kafka", 0) >= 1, ocp[-200:])
        check("context_pack stays small (<4KB)", 0 < cp_res.get("size", 1e9) < 4000, str(cp_res.get("size")))
        check("context_pack surfaces governing decisions", cp_res.get("gov", 0) >= 1, str(cp_res))
        check("context_pack names the tests exercising the target", cp_res.get("tests") is True, str(cp_res))
    else:
        code, ocp = run([py, "-c",
            "import sys, os, json; os.chdir(r'" + str(ws) + "'); sys.path.insert(0, r'" + str(ar) + "'); "
            "import server; o = json.loads(server.context_pack('OrderPublisher')); "
            "ts = o['tests'] if isinstance(o.get('tests'), dict) else {'files': [], 'behaviors': []}; "
            "print('CP:' + json.dumps({'kafka': len(o['kafka']) if isinstance(o['kafka'], list) else 0, "
            "'hasOutline': len(o['outline']) > 0, 'gov': len(o['governing_decisions']) if isinstance(o['governing_decisions'], list) else 0, "
            "'tests': any('OrderPublisherTest.java' in x for x in ts['files']) and 'should publish order created event' in ts['behaviors']}))"], ws)
        m2 = re.search(r"CP:(\{.*\})", ocp)
        import json as _j3
        cp_res = _j3.loads(m2.group(1)) if m2 else {}
        check("context_pack returns focused bundle", cp_res.get("hasOutline") is True and cp_res.get("kafka", 0) >= 1, ocp[-200:])
        check("context_pack surfaces governing decisions", cp_res.get("gov", 0) >= 1, str(cp_res))
        check("context_pack names the tests exercising the target", cp_res.get("tests") is True, str(cp_res))

    # ---- graph augmentation: gap -> assert -> labelled edge ----
    db = sqlite3.connect(ws / ".ariadne" / "index.db")
    check("runtime concatenation reported as UNRESOLVED, not guessed",
          db.execute("SELECT 1 FROM msg_edges WHERE resolved=0 AND topic LIKE '%{?}%'").fetchone() is not None)
    db.close()
    (ws / "docs").mkdir(exist_ok=True)
    (ws / "docs" / "graph-assertions.json").write_text(json.dumps([{
        "kind": "kafka",
        "file": "order-service/src/main/java/com/acme/DynamicPublisher.java",
        "line": 6, "direction": "produce", "topic": "orders.created.prod",
        "confidence": "high", "author": "copilot",
        "evidence": "PREFIX is a static final = orders.created; env is the Spring profile, prod in production.",
    }], indent=2))
    code, oa = run(exe + [idx, "--full"], ws)
    check("assertions load into the graph", "Assertions: 1 loaded" in oa, oa[-200:])
    db = sqlite3.connect(ws / ".ariadne" / "index.db")
    row = db.execute("SELECT source FROM msg_edges WHERE topic='orders.created.prod'").fetchone()
    check("asserted edge is tagged with its author, never mixed with parsed facts",
          row is not None and row[0] == "asserted:copilot", str(row))
    check("parsed edges stay tagged 'static'",
          db.execute("SELECT source FROM msg_edges WHERE topic='orders.created' LIMIT 1").fetchone()[0] == "static")
    db.close()

    # ---- rebuild must not silently empty the graph (extract_cache had to be cleared too) ----
    code, orb = run(exe + [idx, "--rebuild"], ws)
    db = sqlite3.connect(ws / ".ariadne" / "index.db")
    check("--rebuild produces a COMPLETE graph, not an empty one",
          db.execute("SELECT COUNT(*) FROM msg_edges").fetchone()[0] > 5
          and db.execute("SELECT COUNT(*) FROM db_access").fetchone()[0] > 5, orb[-200:])
    check("--rebuild reclassifies tests and re-extracts cases",
          db.execute("SELECT is_test FROM files WHERE path LIKE '%OrderPublisherTest.java'").fetchone()[0] == 1
          and db.execute("SELECT COUNT(*) FROM test_cases WHERE name='shouldPublishOrderCreatedEvent'").fetchone()[0] == 1)
    db.close()

    # ---- corruption auto-recovery ----
    (ws / ".ariadne" / "index.db").write_bytes(b"garbage-not-a-db")
    for sfx in ("-wal", "-shm"):
        (ws / ".ariadne" / f"index.db{sfx}").unlink(missing_ok=True)
    code, oc = run(exe + [idx, "--full"], ws)
    check("corrupt index auto-recovers", code == 0 and "corrupt" in oc.lower()
          and re.search(r"\d+ \(re\)indexed", oc) is not None, oc[-300:])

    # ---- SCIP ingest (compiler-grade layer) via a protobuf fixture ----
    sys.path.insert(0, str(TOOLKIT / "payload" / "ariadne-python"))
    import scip_pb2  # noqa: E402
    sidx = scip_pb2.Index()
    doc = sidx.documents.add()
    doc.relative_path = "order-service/src/main/java/com/acme/OrderController.java"
    occ = doc.occurrences.add()
    occ.symbol = "semanticdb maven . com/acme/OrderController#list()."
    occ.symbol_roles = 1  # definition
    occ.range[:] = [5, 2, 6]
    doc2 = sidx.documents.add()
    doc2.relative_path = "web-app/src/api/orders.ts"
    occ2 = doc2.occurrences.add()
    occ2.symbol = occ.symbol
    occ2.symbol_roles = 0  # reference
    occ2.range[:] = [1, 10, 20]
    scip_file = ws / "fixture.scip"
    scip_file.write_bytes(sidx.SerializeToString())
    ingest = str(ar / ("scip_ingest.mjs" if rt == "node" else "scip_ingest.py"))
    code, osc = run(exe + [ingest, str(scip_file)], ws)
    check("scip ingest exits 0", code == 0, osc[-300:])
    db = sqlite3.connect(ws / ".ariadne" / "index.db")
    check("scip definition indexed",
          db.execute("SELECT 1 FROM scip_defs WHERE symbol LIKE '%OrderController#list()%' AND path LIKE '%OrderController.java'").fetchone() is not None)
    check("scip cross-stack reference indexed",
          db.execute("SELECT 1 FROM scip_refs WHERE symbol LIKE '%list()%' AND path LIKE '%orders.ts'").fetchone() is not None)
    ref_edge = ("SELECT 1 FROM edges e JOIN files s ON s.id=e.src JOIN files d ON d.id=e.dst "
                "WHERE e.kind='ref' AND s.path LIKE '%orders.ts' AND d.path LIKE '%OrderController.java'")
    check("scip ref edge derived (orders.ts -> OrderController)",
          db.execute(ref_edge).fetchone() is not None)
    db.close()

    # ---- SCIP ref edges must survive incremental reindexing ----
    # An unrelated change must not disturb compiler-grade edges: the indexer owns
    # kind='import' rows only, kind='ref' rows are scip_ingest's to manage.
    dao = ws / "billing-service" / "src/main/java/com/acme/PaymentDao.java"
    dao.write_text(dao.read_text() + "// touched after scip\n")
    git(["add", "-A"], ws / "billing-service")
    git(["commit", "-qm", "t2"], ws / "billing-service")
    code, oi = run(exe + [idx, "--incremental"], ws)
    db = sqlite3.connect(ws / ".ariadne" / "index.db")
    check("ref edges survive incremental of an unrelated file",
          db.execute(ref_edge).fetchone() is not None, oi[-200:])
    # A reindexed file gets a fresh rowid (MAX(id)+1: the previous step just handed the
    # current max to PaymentDao). Park a ref edge on exactly that id: an indexer that
    # clears ALL edge kinds for reindexed files destroys it, one that rebuilds only its
    # own import edges keeps it.
    next_fid = db.execute("SELECT MAX(id)+1 FROM files").fetchone()[0]
    ctrl_fid = db.execute("SELECT id FROM files WHERE path LIKE '%OrderController.java'").fetchone()[0]
    db.execute("INSERT INTO edges(src, dst, kind) VALUES(?,?,'ref')", (next_fid, ctrl_fid))
    db.commit()
    db.close()
    kt = ws / "stream-service" / "src/main/kotlin/com/acme/OrderHandler.kt"
    kt.write_text(kt.read_text() + "// touched\n")
    git(["add", "-A"], ws / "stream-service")
    git(["commit", "-qm", "t3"], ws / "stream-service")
    code, oi2 = run(exe + [idx, "--incremental"], ws)
    db = sqlite3.connect(ws / ".ariadne" / "index.db")
    check("reindex rebuilds only kind='import' edges (ref edge on reindexed file kept)",
          db.execute("SELECT 1 FROM edges WHERE src=? AND dst=? AND kind='ref'",
                     (next_fid, ctrl_fid)).fetchone() is not None, oi2[-200:])
    db.execute("DELETE FROM edges WHERE src=? AND dst=? AND kind='ref'", (next_fid, ctrl_fid))
    db.commit()
    db.close()

    # ---- ref edges must also survive reindexing of their OWN endpoints ----
    # index_file swaps the files row, which hands the path a fresh id; without
    # carrying non-import edges across the swap, the cascade eats them silently.
    orders_ts = ws / "web-app" / "src/api/orders.ts"
    orders_ts.write_text(orders_ts.read_text() + "// touched after scip\n")
    ctrl = ws / "order-service" / "src/main/java/com/acme/OrderController.java"
    ctrl.write_text(ctrl.read_text() + "// touched after scip\n")
    code, ose = run(exe + [idx, "--full"], ws)
    db = sqlite3.connect(ws / ".ariadne" / "index.db")
    check("ref edge survives reindex of its own src and dst files",
          code == 0 and db.execute(ref_edge).fetchone() is not None, ose[-300:])
    db.close()

    # ---- MCP tool smoke (end-to-end through the protocol / module surface) ----
    if rt == "node":
        client = ws / ".ariadne" / "_smoke.mjs"
        client.write_text("""import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t = new StdioClientTransport({ command: "node", args: [".ariadne/server.mjs"], cwd: process.cwd() });
const c = new Client({ name: "smoke", version: "1" });
await c.connect(t);
const names = (await c.listTools()).tools.map((x) => x.name);
const need = ["decisions", "decision_trace", "save_decision", "explain", "save_insight", "message_flow", "db_map", "http_map", "todos"];
if (!need.every((n) => names.includes(n))) { console.error("MISSING:" + need.filter((n) => !names.includes(n))); process.exit(1); }
const r = await c.callTool({ name: "decisions", arguments: { target: "orders.created" } });
if (!r.content[0].text.includes("ADR-012")) { console.error("decisions tool wrong: " + r.content[0].text.slice(0, 200)); process.exit(1); }
console.log("MCP_SMOKE_OK tools=" + names.length);
await c.close();
""")
        code, om = run(["node", str(client)], ws)
        check("MCP smoke (protocol round-trip)", code == 0 and "MCP_SMOKE_OK" in om, om[-300:])
        client.unlink(missing_ok=True)
    else:
        code, om = run([py, "-c",
            "import sys, os, json; os.chdir(r'" + str(ws) + "'); sys.path.insert(0, r'" + str(ar) + "'); "
            "import server; r = json.loads(server.decisions(target='orders.created')); "
            "assert any(x['id'] == 'ADR-012' for x in r), r; "
            "t = server.decision_trace('ADR-007'); assert 'ADR-012' in t, t; print('MCP_SMOKE_OK')"], ws)
        check("MCP smoke (module surface)", code == 0 and "MCP_SMOKE_OK" in om, om[-300:])

    # ---- docgen ----
    dg = str(ar / ("docgen.mjs" if rt == "node" else "docgen.py"))
    code, out6 = run(exe + [dg], ws)
    check("docgen exits 0", code == 0, out6[-400:])
    gen = ws / "docs" / "generated"
    for f_ in ["architecture.md", "message-flows.md", "data-map.md", "http-map.md", "PROGRESS.md", "agent-context.md"]:
        check(f"docgen wrote {f_}", (gen / f_).exists())
    check("PROGRESS computes 40%", "40%" in (gen / "PROGRESS.md").read_text(encoding="utf-8"))
    ac_lines = len((gen / "agent-context.md").read_text(encoding="utf-8").splitlines())
    check("agent-context.md stays bounded at scale (<60 lines)", ac_lines < 60, f"{ac_lines} lines")
    check("large generated docs carry a do-not-read banner",
          "Do not read it whole" in (gen / "data-map.md").read_text(encoding="utf-8"))
    check("http-map shows caller", "axios" in (gen / "http-map.md").read_text(encoding="utf-8"))
    check("docgen wrote decisions.md", (gen / "decisions.md").exists())
    check("decisions.md shows supersession",
          "superseded by **ADR-012**" in (gen / "decisions.md").read_text(encoding="utf-8"))
    mfd = (gen / "message-flows.md").read_text(encoding="utf-8")
    check("message-flows mermaid is production-only",
          "OrphanConsumerIT" not in mfd.split("## Per-topic detail")[0])
    check("message-flows lists tested-by sites", "tested by:" in mfd)
    check("data-map mermaid is production-only",
          "test_scratch" not in (gen / "data-map.md").read_text(encoding="utf-8").split("## Per-table detail")[0])
    check("agent-context reports indexed test files",
          "test files indexed" in (gen / "agent-context.md").read_text(encoding="utf-8"))

    # ---- plugin hooks: pass extension populated todos table ----
    db = sqlite3.connect(ws / ".ariadne" / "index.db")
    check("extension pass ran (todos table)",
          db.execute("SELECT COUNT(*) FROM todos").fetchone()[0] >= 1)
    db.close()
    check("extension pass logged", "extension pass: todo.pass" in out1)

    # ---- enrichment plan mode (drives Copilot/external providers) ----
    en0 = str(ar / ("enrich.mjs" if rt == "node" else "enrich.py"))
    code, op = run(exe + [en0, "--plan"], ws)
    import json as _json
    try:
        plan = _json.loads(op.strip().splitlines()[-1])
        check("enrich --plan returns prompt pack JSON", code == 0 and len(plan) >= 4 and "prompt" in plan[0])
    except Exception as ex:
        check("enrich --plan returns prompt pack JSON", False, str(ex) + op[-200:])

    # ---- enrichment (mock provider: no network) ----
    en = str(ar / ("enrich.mjs" if rt == "node" else "enrich.py"))
    code, oe1 = run(exe + [en, "--provider", "mock"], ws)
    check("enrich (mock) exits 0", code == 0, oe1[-300:])
    code, oe2 = run(exe + [en, "--provider", "mock"], ws)
    check("enrich second run fully hash-cached", re.search(r"0 generated, \d+ cached", oe2) is not None, oe2[-300:])
    db = sqlite3.connect(ws / ".ariadne" / "index.db")
    check("insights stored per module",
          db.execute("SELECT COUNT(*) FROM insights WHERE kind='module'").fetchone()[0] >= 4)
    db.close()
    check("insights.md written", (gen / "insights.md").exists())

    # ---- config: extraExtensions both adds mappings and beats the built-ins ----
    (ws / ".ariadne" / "config.json").write_text(json.dumps(
        {"extraExtensions": {".vue": "javascript", ".h": "cpp"}}))
    w(ws / "web-app" / "src/components/Widget.vue", "export const widget = () => 1;\n")
    w(ws / "order-service" / "src/main/native/helper.h", "int helper(void);\n")
    for r in ("web-app", "order-service"):
        git(["add", "-A"], ws / r)
        git(["commit", "-qm", "ext"], ws / r)
    code, ox = run(exe + [idx, "--full"], ws)
    check("config.json overrides loaded", "config.json overrides" in ox, ox[-200:])
    db = sqlite3.connect(ws / ".ariadne" / "index.db")
    check("extraExtensions adds new mappings (.vue -> javascript)",
          db.execute("SELECT 1 FROM files WHERE path LIKE '%Widget.vue' AND lang='javascript'").fetchone() is not None)
    check("extraExtensions overrides built-ins (.h remapped c -> cpp)",
          db.execute("SELECT 1 FROM files WHERE path LIKE '%helper.h' AND lang='cpp'").fetchone() is not None)
    db.close()

    # ---- setup script (hooks) ----
    setup = str(ar / ("setup.mjs" if rt == "node" else "setup.py"))
    code, out7 = run(exe + [setup], ws)
    check("setup script exits 0", code == 0, out7[-400:])
    check("hooks installed in all repos",
          all((ws / r / ".git" / "hooks" / "post-commit").exists()
              for r in ["order-service", "billing-service", "web-app", "docs-repo"]))

    # ---- skills & agents: frontmatter integrity ----
    import re as _re2
    skills_dir = TOOLKIT / "payload" / ".github" / "skills"
    names, ok = set(), True
    for sd in sorted(skills_dir.iterdir()):
        md = sd / "SKILL.md"
        if not md.exists():
            ok = False
            print(f"        (missing SKILL.md in {sd.name})")
            continue
        text = md.read_text(encoding="utf-8")
        fm = _re2.match(r"^---\n(.*?)\n---\n", text, _re2.S)
        if not fm:
            ok = False
            print(f"        (no frontmatter: {sd.name})")
            continue
        nm = _re2.search(r"^name:\s*(\S+)", fm.group(1), _re2.M)
        ds = _re2.search(r"^description:\s*(.+)", fm.group(1), _re2.M)
        if not nm or not ds or nm.group(1) != sd.name or len(ds.group(1)) < 40:
            ok = False
            print(f"        (bad name/description: {sd.name})")
            continue
        names.add(nm.group(1))
    check("all skills have valid, unique, directory-matching frontmatter", ok and len(names) == len(list(skills_dir.iterdir())))
    check("ergonomics skills present", {"codebase-orientation", "change-impact-analysis", "flow-tracing",
                                        "safe-schema-change", "event-contract-change", "aegis-help",
                                        "graph-augmentation"} <= names)
    agents_dir = TOOLKIT / "payload" / ".github" / "agents"
    agent_names = set()
    agents_ok = True
    for f in agents_dir.glob("*.agent.md"):
        text = f.read_text(encoding="utf-8")
        fm = _re2.match(r"^---\n(.*?)\n---\n", text, _re2.S)
        nm = _re2.search(r"^name:\s*(\S+)", fm.group(1), _re2.M) if fm else None
        if not fm or not nm or nm.group(1) != f.name.replace(".agent.md", ""):
            agents_ok = False
        else:
            agent_names.add(nm.group(1))
    check("agents have valid, name-matching frontmatter", agents_ok)
    check("full agent roster present",
          {"daedalus", "argus", "themis", "hermes", "pythia",
           "asclepius", "hephaestus", "metis"} == agent_names, str(sorted(agent_names)))

    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + ", ".join(FAILURES))
        sys.exit(1)
    print(f"ALL TESTS PASSED ({rt} edition)")
    if not args.keep:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
