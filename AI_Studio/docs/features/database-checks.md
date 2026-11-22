# Database checks

After a test changes data, a run can also check what the database stored: the row the write made is there, no row points at a row
that does not exist, and no unique value is held twice. It reads through a small **database probe** that you run next to your
database, with your own read-only database user. AI Studio keeps only the probe's address and token. Your database password never
leaves your network, and what comes back is counts, never your data.

Database checks are off until a person sets them up. See [multi-layer-validation.md](multi-layer-validation.md) for how they fit with
the other checks and where a run says which layers it checked.

## What is checked

The checks come from the keys your database declares, through the probe's schema (table and column names, keys and row counts only):

| Check | In words | Holds when |
|---|---|---|
| Stored | `exists orders where id = '{{orderId}}'` | after a write answered 2xx, its row is stored (the id it returned, or the fields it changed) |
| No orphans | `orphans order_lines(product_id) -> products(id)` | the test added no row that points at a missing row, along each declared foreign key |
| No duplicates | `duplicates users(email)` | the test added no second row with a value of a declared unique key |

Each is a test step, `assertResponse` with `check: "dbCheck"` (`src/engine/database/checks.ts`). The last two are read before the test's
first step and again at the step, so only what the test added counts. A run makes at most 40 database checks, and only in tests that
change data (**Include API tests that change data** on, on the Requirements tab). A result is a count, fingerprints of the matching rows' keys and masked keys such as
"•••••• (8 characters)": the key values themselves never leave the probe.

## Turning them on

**Settings, Test data, Database checks** has three fields:

- **Check the database after tests that change data**: the on switch.
- **Probe address**: `https://...`, the address of your probe. Plain `http://` only for a probe on the platform's own computer
  (`127.0.0.1` or `localhost`). With `BLOCK_PRIVATE_TARGETS=true` the address must resolve to a public address, as an application's
  address must.
- **Probe token**: the token you gave the probe, at least 24 characters. It is stored encrypted (the platform's `SECRET_KEY`) and never
  shown again; the field then says a token is saved. Type a new one to replace it.

Saving with an empty address removes the setting. Changing it needs "Change project settings". The routes are
`GET` and `PUT /api/projects/:id/db-probe` (`src/platform/routes/db-probe.ts`); the answer is `{ enabled, url, tokenSaved }`, never the
token.

When a run cannot read the probe (wrong token, address not reachable), its database checks are skipped and **Checked layers** says why.

## Setting up the probe

The reference probe is `examples/db-probe/` in this repository: plain Node.js 24, no dependencies, with an adapter for SQLite files
(`node:sqlite`). For PostgreSQL or MySQL, write an adapter with your database driver (see [Other databases](#other-databases)).

1. **A read-only database user.** Create a user that may only read the tables you want checked. The probe adds its own limits on
   top, but the database's own permission is the first one.
2. **An allow-list.** A JSON file of the tables and columns the probe may read; nothing else is served or read. Leave out passwords,
   tokens and anything else the checks do not need:

   ```json
   {
       "users": ["id", "email", "role"],
       "orders": ["id", "user_id", "status", "total"],
       "order_lines": ["id", "order_id", "product_id", "qty"]
   }
   ```

3. **A token.** A random value of at least 24 characters in a file only the probe can read, for example
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" > probe-token && chmod 600 probe-token`.
4. **Start it with TLS:**

   ```sh
   node examples/db-probe/server.mjs --sqlite /path/to/app.db --token-file probe-token --allow allow.json \
       --cert probe-cert.pem --key probe-key.pem --host 0.0.0.0 --port 8790 --audit probe-audit.log
   ```

   Without `--cert` and `--key` the probe serves plain HTTP on a loopback address only (behind your own TLS proxy, or for a trial on
   one computer); any other address without TLS is refused at start.
5. **Let only AI Studio reach it.** Open the port to the platform's address only, in your firewall or proxy.
6. **Save the address and the token** in Settings, Test data, Database checks, and switch it on.

Options, with their defaults:

| Option | Default | What it limits |
|---|---|---|
| `--row-cap` | 100000 | a check on a table with more rows is refused (HTTP 413) |
| `--timeout-ms` | 5000 | a check that runs longer is stopped and refused (HTTP 504) |
| `--per-minute` | 120 | more requests in a minute are refused (HTTP 429) |
| `--audit` | standard error | one JSON line per request: time, caller's address, the check's kind and table, the status, the count or the reason |

## What the probe refuses

The probe serves `GET /schema` and `POST /check` only, with `Authorization: Bearer <token>`. A check is one of four read templates
(`exists`, `count`, `orphans`, `duplicates`), named by table and column names only, with the values in `params` and only ever bound.
It refuses, with the rule in the answer:

- any other kind of check, a write included, and any field beside the template's own (SQL text is never accepted);
- a table or column that is not on the allow-list, including the database's own tables;
- values that are not text, numbers or null, and params beyond the check's columns;
- a request over 16 KB, a table over the row cap, a check over the statement timeout, too many requests, a wrong token.

Below these checks the SQLite adapter opens the file read-only, runs each check inside its own transaction, and sets SQLite's
authorizer so that only reads of allow-listed tables and columns are allowed: a write, a pragma or an attached database is refused by
SQLite itself. The probe's answer is counts, fingerprints and masked keys; the platform checks that shape again and refuses anything
else (`src/engine/database/remote.ts`). The audit log never holds a value from a request or a row. The refusal list is tested in
`tests/db-probe-refusals.test.ts`.

Relations over rows (a rule such as "total equals the sum of the lines") are not run through a probe.

## Other databases

An adapter is an object with five functions (`examples/db-probe/probe.mjs` documents them):

- `introspect()`: the tables with their columns, primary key, unique keys and foreign keys;
- `quote(name)`: an identifier quoted for the dialect (`"name"` in PostgreSQL, `` `name` `` in MySQL);
- `fold(expression)`: the case-folding expression, such as `lower(...)`;
- `read(statements, { timeoutMs })`: runs `[{ sql, params }]` with `?` placeholders in one read-only transaction and returns each
  statement's rows. PostgreSQL: `BEGIN READ ONLY`, `SET LOCAL statement_timeout`, the statements with `?` numbered as `$1, $2, ...` in
  order, then `ROLLBACK`. MySQL: `START TRANSACTION READ ONLY` and `MAX_EXECUTION_TIME`. Past the timeout it stops the query and rejects
  with `ProbeTimeout`;
- `close()`.

Pass it to `createProbe({ adapter, token, allow })` and serve the returned handler with `node:https`, as `server.mjs` does.
