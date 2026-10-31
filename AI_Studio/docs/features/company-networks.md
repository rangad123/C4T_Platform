# Company networks: proxies and company certificates

## What it does for you

Many companies send every connection to the internet through a **proxy**, and many run a **security tool that re-signs https traffic** with the company's own certificate. A runner (and the platform server) used to fail there with "network error" or "certificate was not accepted". Now:

- The runner finds the proxy by itself (the same variables other tools use, or on Windows the proxy you set in Windows), sends its own connections through it, and passes it on to the programs it starts (npm, the browser download, its helpers).
- It trusts the computer's own certificate store, so a company certificate that IT installed on the computer works without anything to set. A certificate file can be added with `--ca-file`.
- When the network is the problem, the runner window says which problem and what to do, in one sentence. Once the runner is connected, its row under **Setup, Runners** shows the proxy it uses and its last network problem.
- The platform server's own outbound calls (AI model, webhooks and notifications, issue trackers) follow the same proxy variables and trust the server's certificate store.

## Starting a runner behind a proxy

Usually nothing: if Windows has a proxy set (Settings, Network and internet, Proxy, "Use a proxy server"), or `HTTPS_PROXY` is set, the runner uses it. The first lines of the runner window say what it uses:

```
Network: connecting through the proxy http://proxy.corp.example:8080, from the Windows proxy setting. Reached directly: *.corp.example, localhost, 127.0.0.1, ::1, [::1].
Tests reach the application directly. Start the runner with --proxy-tests to send them through the proxy as well.
Certificates trusted: Node.js's own, this computer's certificate store (14 more).
```

Which setting wins (first match):

| | Where | Example |
|---|---|---|
| 1 | `--proxy <address>` on the command line (or `--proxy none`: no proxy at all) | `--proxy http://proxy.corp.example:8080` |
| 2 | The variables `HTTPS_PROXY` and `HTTP_PROXY` (either case; lower case wins when both are set) | `HTTPS_PROXY=http://proxy.corp.example:8080` |
| 3 | `"proxy"` in the runner download's `runner.json` | `"proxy": "http://proxy.corp.example:8080"` |
| 4 | Windows only: the person's own proxy setting, read with `reg query` from `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` (`ProxyEnable`, `ProxyServer`, `ProxyOverride`). This reads a setting; it never looks at other programs. | |

Addresses reached **without** the proxy: `--proxy-bypass`, else `NO_PROXY`, else `"noProxy"` in runner.json, else (when the proxy came from Windows) the Windows exceptions. The computer's own addresses (`localhost`, `127.0.0.1`, `::1`) are always reached directly. The list is the usual NO_PROXY form, separated by commas: `host`, `host:port`, `.example.com` (example.com and everything under it), `*.example.com` (everything under it), `*` (everything). Those are the forms both of Node's proxy implementations (fetch and http.request) understand the same way; tested here against Node 24.19.

A proxy that needs a password: put it in the address, `http://user:password@proxy:8080` (special characters with %-codes, `@` as `%40`). **The password is a secret**: the runner never prints it (the window shows `http://user:***@proxy:8080`), masks it in every log line, heartbeat and run result, and never sends it to the platform; the platform only learns `proxy:8080`. The person types it in one place (the command line, the variable or runner.json); the platform never has it, so it is never in a download.

The other runner.json lines a person may add (none is required, the variables and flags win): `"noProxy": "intranet.example,.corp.example"`, `"caFile": "company-root.pem"` (relative to the runner folder), `"proxyTests": true`.

### The application under test

The proxy is for the runner's own connections. **Tests reach the application directly** unless the runner is started with `--proxy-tests` (or `AITP_PROXY_TESTS=1`): then the run's Playwright configuration gets Playwright's own `proxy` option (address, sign-in and the exceptions read from the environment when the run starts, never written into the configuration file), so the browser and the tests' API calls go through the proxy too. Use it when the application is only reachable through the proxy (a public staging site from inside a company network). Without it, the runner gives the browser no proxy, so it follows its own default (Chromium-family browsers usually follow the system proxy setting on Windows and macOS and the proxy variables on Linux; that is the browser's behaviour, not checked here), and the tests' API calls (Playwright's `request`, which reads no proxy variables) go directly.

The clean-up of test data after API tests is sent by the runner itself, so it follows the proxy and the exceptions like the runner's other connections: add the application's address to the exceptions if it must be reached directly.

## Company certificates

The runner trusts, for its own https connections:

1. Node.js's own list (as before), including `NODE_EXTRA_CA_CERTS` if it is set;
2. **this computer's certificate store** (on Windows the trusted roots IT installs, on macOS the keychain, on Linux the system bundle), added with `tls.getCACertificates("system")`. `AITP_SYSTEM_CA=0` turns this off;
3. a certificate file given with `--ca-file <file>` (or `AITP_CA_FILE`, or `"caFile"` in runner.json): one or more PEM certificates, or one DER `.cer`/`.crt`. Every certificate in it is read at start, so a wrong file is refused with a plain message before the runner connects (exit code 2), at most 2 MB and 500 certificates.

The programs the runner starts get the same trust: `NODE_USE_SYSTEM_CA=1` and `NODE_EXTRA_CA_CERTS` (the company file; when `NODE_EXTRA_CA_CERTS` already named another file, both in one file in the runner's work folder, because Node reads only one). Those two, and `AITP_PROXY_TESTS`, were added to the short list of variables the test process may inherit, so a test's API calls to an application with a company certificate work too.

## What the runner says

Each sentence is printed in the runner window (it keeps trying, waiting 1 s growing to 30 s) and, once it is connected again, shown on its row as "Network problem 5 minutes ago: ..." (for an hour).

| Situation | What it says (shortened) |
|---|---|
| The proxy wants a password | `Could not reach platform.example: the proxy http://proxy:8080 asks for a user name and password (HTTP 407). Add them to the proxy address, for example --proxy http://user:password@proxy:8080. The password is never shown or sent to the platform.` From the Windows setting it adds that a proxy accepting only the Windows sign-in (NTLM or Kerberos) cannot be used. |
| The password is wrong | `... the proxy http://maya:***@proxy:8080 did not accept the user name and password (HTTP 407). Check them. Special characters ...` |
| The proxy blocks the platform | `... the proxy ... refused the connection to platform.example (HTTP 403). The company network may block this address. Ask IT to allow platform.example.` A web filter that answers with its own page instead says "Something between this computer and the platform blocked the request (HTTP 403, a web page instead of the platform's answer)". |
| The proxy is down or misspelled | `... the proxy http://proxy:8080 could not be reached (the connection was refused). Check the proxy address (set by --proxy). If this network needs no proxy, start the runner with --proxy none.` |
| A security tool re-signs https | `... the platform's certificate was not accepted (SELF_SIGNED_CERT_IN_CHAIN): the connection is signed by a certificate this computer does not trust. A company security tool that inspects https traffic usually causes this. Ask IT for the company's root certificate (a .pem or .crt file) and start the runner with --ca-file <file>, or install it in this computer's certificate store.` The same for `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `DEPTH_ZERO_SELF_SIGNED_CERT`. An expired certificate points at the clock; a certificate for another name at the address. |
| The address cannot be found (no proxy set) | `... the address could not be found (check --url and the network). On a company network the platform may only be reachable through a proxy: start the runner with --proxy http://host:port.` |
| The connection never gets through (no proxy set) | `... the connection did not get through. A firewall may block it. On a company network you may need a proxy ...` |
| Windows uses an automatic proxy script | `Windows is set to find the proxy with an automatic setup script (PAC). The runner cannot read those scripts, so it connects directly. If it cannot reach the platform, ask IT for the proxy address and start the runner with --proxy http://host:port.` |

Notes printed once at start: Windows exceptions the runner cannot use (`<local>`, `10.*`), a Windows setting that names only a SOCKS proxy, `--proxy-tests` without a proxy, and a Node.js too old for one of the parts (below).

## The platform server

Where the server and the standalone worker start (`src/main.ts`, `src/worker-main.ts`, one line each, `src/platform/outbound-network.ts`):

- `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` (either case) send everything the server sends with Node's `fetch` or `http(s).request` through the proxy. That includes the AI model providers (the AI SDK uses `fetch`; tested), webhooks and notifications, and the issue trackers. The server's own addresses are always reached directly. Unset: nothing changes.
- The server trusts its computer's certificate store besides Node's own list (`AITP_SYSTEM_CA=0` turns it off); `NODE_EXTRA_CA_CERTS` keeps working.
- At start it prints, for example, `[network] Outbound calls (AI models, webhooks, notifications, issue trackers) go through the proxy http://svc:***@proxy:8080. Reached directly: localhost, 127.0.0.1, ::1, [::1].` A proxy address it cannot read is named with the reason and not used.
- Not covered: email (SMTP and IMAP connect directly), and the platform's own test browser, which follows its own proxy rules as described above. `AITP_PROXY_TESTS=1` on the server gives the platform's own test runs Playwright's proxy option too.
- Security assessments connect directly to the address their guard checked, unless `SECURITY_USE_PROXY=on`: then they use these same variables, the guard still checks every address first, and the proxy resolves the name itself (see "The company proxy (OPS)" in [security-assessment.md](security-assessment.md)).

## How it is built

- `src/engine/net/company-network.ts`: reading proxy addresses (http, https, `host:port`; SOCKS and PAC are refused in words), masking (`http://user:***@host`), NO_PROXY matching, writing the variables (on Windows only the upper-case names, since Windows has one variable per name), `applyGlobalProxy` (Node's `http.setGlobalProxyFromEnv`, Node 24.14+), `applyTrust` (`tls.getCACertificates` / `tls.setDefaultCACertificates`, Node 24.5+), reading certificate files, and `describeNetworkError`, which walks an error's causes (undici's "Proxy response (407)", Node's `ERR_PROXY_TUNNEL`, certificate codes, the proxy's address in `ECONNREFUSED`) and returns the reason and the advice. No new dependency.
- `src/agent/net.ts`: the order of the settings, runner.json, the Windows reader (`%SystemRoot%\System32\reg.exe query ...`, by its full path, never a PATH lookup; 5 s limit), applying it all and the report sent to the platform. `config.ts` adds the four options, `main.ts` sets the network up before the first connection, `index.ts` reads runner.json, `client.ts` uses the plain sentences and adds the report to `hello` and `poll`.
- `src/engine/net/test-proxy.ts`: `--proxy-tests` in the run's Playwright configuration; off, the configuration is byte for byte what it was.
- Protocol (additive, optional, version 1): `Capabilities.network = { proxy?: "host:port", proxySource?: "flag" | "env" | "file" | "windows", proxyTests?, certificates?: ("system" | "file" | "extra")[], problem?, problemAt? }`. The schema refuses a `proxy` that is not plain `host:port` (so a sign-in can never be stored), and the platform masks `user:password@` in `problem` once more before answering `GET /api/projects/:id/agents`. Shown on the runner's row (`web/src/features/agents/network.tsx`).

## Limits (what is not covered)

- **Automatic proxy scripts (PAC, WPAD, "Automatically detect settings") are not supported.** Give the proxy address with `--proxy`.
- **Proxies that accept only the Windows sign-in (NTLM, Kerberos, Negotiate) are not supported**: Node.js sends only a user name and password (Basic). Ask IT for a proxy address that accepts a user name and password, or run a local helper proxy that signs in for you and point `--proxy` at it.
- **SOCKS proxies are not supported.**
- Windows: only the per-user setting is read (not a machine-wide policy or WinHTTP's `netsh winhttp` setting); `<local>` and exceptions with a `*` in the middle or at the end are not used (the runner says so).
- Needs Node.js 24.14 or newer for the proxy and 24.5 or newer for the certificates. On an older Node.js 24 each part is skipped with a plain note (the complete download brings a new enough Node.js).
- Recordings and live sessions on a runner do not get `--proxy-tests` (only test runs do); their browser follows its own default.
- **Not tested against a real company proxy, a real security tool or real NTLM/PAC setups**: there is none here. Everything is tested against a local CONNECT proxy (plain Node `http`, with and without a password, and one that refuses an address), a local https server with a test-only company certificate (`tests/fixtures/tls/company`, its root key thrown away), and a fake `reg` (`tests/fixtures/fake-reg.mjs`, pointed at with `AITP_REG_PATH`, a variable for tests only). The Windows registry reader was run against this computer's real setting (proxy off) and against the fake. macOS and Linux certificate stores were not tried (only Windows here).

Tests: `tests/company-network-unit.test.ts` (fast tier: addresses, masking, NO_PROXY, which setting wins, runner.json, the Windows reader and the fake `reg`, the environment for child processes, `--proxy-tests` byte-identical when off, the sentences) and `tests/company-network.test.ts` (under the browser lock: the real runner program through the proxy with a password to an https platform behind the company certificate, a task whose script prints the proxy variables with the password masked in the result and absent from heartbeats and output, the sentences for 407, a wrong password, an untrusted certificate, a proxy that is down, a blocked address, NO_PROXY, the Windows setting through the fake `reg`, the platform's runner row and its refusal of a sign-in, the server's AI model call through the proxy and the company certificate, and a runner download built with a proxy password in the server's environment).
