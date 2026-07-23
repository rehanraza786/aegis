---
name: safe-schema-change
description: Change the database schema correctly — add or alter a table or column — through the migration layer this codebase actually uses (Liquibase, Flyway, Prisma, Rails, or Alembic; `db_map`'s changeset tags show which), verifying afterwards that code and schema agree. Use whenever a change involves a new table, a new column, a type change, an index, a constraint, a new entity, or a new repository. Trigger on "add a field to", "new table", "migration", "changeset", or any request that implies persisted data that doesn't exist yet.
---

# Safe Schema Change

Schema is the one place where a confident wrong guess costs a production
incident. This codebase has an actual procedure; follow it rather than inventing
one, and verify with the graph rather than hoping.

**The rule that overrides everything: every schema change goes through a
Liquibase changeset. Never hand-edit a database, never rely on Hibernate
`ddl-auto` to create anything, and never assume a table exists because an entity
references it.**

## Step 1 — Establish the current truth (before writing anything)

- `db_map <table>` — does the table already exist? What changesets shaped it?
  Who reads and writes it today?
- If the table shows **DRIFT: accessed by code but no changeset defines it**, stop
  and report that first. You have found a pre-existing bug, and building on top of
  it will bury it.
- `blast_radius` on the entity and the repository — everything that will need to
  keep compiling.
- `decisions target:<table>` — is ownership of this table governed by an ADR?
  (Common pattern: "the payments table is written exclusively by
  billing-service.") If your change would write to a table another service owns,
  that is a conflict to surface, not a detail to work around.

## Step 2 — Write the changeset

Match the format the repo already uses — `db_map` shows you which changelog files
exist and what style they're in (XML, YAML, or formatted SQL). Do not introduce a
new format.

- New changeset with a unique `id` and the correct `author`. Never edit an
  existing changeset that has already been applied anywhere; Liquibase checksums
  will reject it and you will have created a deployment failure.
- Additive first. Adding a nullable column is safe. Dropping or renaming a column
  is a breaking change that needs a migration path (add → backfill → switch reads
  → stop writing → drop, across releases), and you should say so plainly rather
  than generating a one-shot `dropColumn` and calling it done.
- Include a rollback where the format supports it.
- Register the changeset in the master changelog if the repo uses an include
  chain.

## Step 3 — Update the code side

- The JPA entity: field, annotations, and the correct column mapping. If the repo
  uses an explicit `@Table(name = …)`, keep using it; if it relies on the
  camelCase → snake_case default, match that convention instead of hardcoding.
- Lombok-generated accessors do not need writing by hand — `@Getter`/`@Setter`/
  `@Data` cover them, and the graph already knows they'll exist.
- Repositories, queries (`@Query`, JdbcTemplate SQL, Querydsl), and any DTO or
  mapper that carries the field through to an API response. Use the `db_map`
  access list from Step 1 as the checklist — every site on it is a site to
  consider.

## Step 4 — Verify with the graph (this is not optional)

Reindex, then:

- `db_map <table>` again. The new changeset must appear in the schema history,
  and there must be **no DRIFT warning**. A drift warning after your change means
  the code and the changelog disagree — that is the bug this whole procedure
  exists to prevent, and you caught it before the deploy.
- If the field is exposed over HTTP, `http_map` on the affected endpoints to see
  which frontend callers may need updating.
- If the field is carried on a Kafka payload, `message_flow` on the topic — every
  consumer listed is a service whose deserialization you may have just changed.
  Adding a field is usually safe; removing or renaming one is not.

## Step 5 — Report

```
## Schema change: <what>

**Changeset.** <file>:<id> by <author> — <operation>
**Entity.** <path:line> — <field, type, mapping>
**Code sites updated.** <list from db_map, each path:line>
**Verification.** db_map shows <table> → <ops>, no drift. ✓
**Downstream.** HTTP: <endpoints/callers affected, or none>.
                Kafka: <topics/consumers affected, or none>.
**Migration safety.** Additive / breaking — <and if breaking, the staged plan>
```

## Rules

- A schema change with no changeset is not a schema change, it's a bug.
- Never change an applied changeset. Add a new one.
- Never silently write to a table another service owns — check `decisions` and
  `db_map` first, and if it's owned elsewhere, say so.
- Always re-run `db_map` afterwards. "It compiles" is not verification; "no drift
  warning" is.
