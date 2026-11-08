# What a run may take from a runner's computer

Node cannot put a process in a cgroup (Linux) or a job object (Windows) without extra packages. So the runner uses the limits below, which work the same on Windows, macOS and Linux (`src/agent/resources.ts`). Each one is set in the runner's environment.

| What | Default | Setting | Enforced |
|---|---|---|---|
| Priority of test processes | below normal | `AITP_AGENT_TEST_PRIORITY` = `normal`, `below-normal` or `low` | The task's process is lowered before the run is sent to it (`os.setPriority`). The test runner, its workers and the browsers they start inherit it. This was checked on Linux, including a process started by the task's process. On Windows the priority class is inherited by child processes; this was not run here. |
| Node heap of test processes | 2048 MB | `AITP_AGENT_TEST_HEAP_MB`, 256–65536; `0` = Node's own limit | `--max-old-space-size` on the task's process. The web test runner and its workers get it through `NODE_OPTIONS` (`AITP_TEST_HEAP_MB`, a number only). Browsers are not Node processes and are not capped by it. The phone, iOS and Windows desktop runners get only the task's process cap. |

### What changed for existing runners

Both limits are new in round 40 and are on by default, so a runner that updates behaves differently from before:

- **Below-normal priority reaches more than the browsers.** Everything the task's process starts inherits it: the test runner, its workers, the browsers, and also an Android emulator and the adb server when a phone run starts them, and the iOS tools a run calls (this was not checked on a Mac). An emulator the runner keeps running between runs, and an adb server started during a run, stay at below-normal priority for later runs too. On a busy computer this can make phone runs slower. Set `AITP_AGENT_TEST_PRIORITY=normal` to go back to the old behaviour.
- **2048 MB is a new heap limit.** Before, the test processes had Node's own limit, which on a computer with plenty of memory is larger than 2048 MB. A suite that needed more heap than that (very large data sets held in memory, many workers' worth of results in one process) now stops with Node's out-of-memory error. Raise `AITP_AGENT_TEST_HEAP_MB`, or set it to `0` for Node's own limit.
| Memory of the whole run | off | `AITP_AGENT_TEST_MEMORY_MB` (MB) | Linux and macOS: the resident memory of the task's process tree, browsers included, is read with `ps` every 5 s. A run over the limit is stopped with "The run used N MB of memory, more than the M MB this runner allows…". Shared memory is counted once per process, so set the limit generously. **Windows: not enforced** (no dependable way without extra packages). macOS uses the same `ps` call as Linux; it was not run on a Mac here. |
| Free disk space | 512 MB | `AITP_AGENT_MIN_FREE_MB`; `0` = off | Checked (`fs.statfs` on the work folder) before a task is taken. A protocol-2 runner turns the task down with reason `other` and a sentence, so another runner can take it. A protocol-1 platform gets `ok: false` with the same sentence. Recordings and phone sessions are not checked. |
| Time | unchanged | the task's own limits | The runner's watchdog (the task's limit + 90 s) and the platform's deadlines, as before. |

## Disk use on the runner

- **Task folders** (`<work folder>/tasks/<task>`) are removed when the task ends. All of them are removed when the runner starts, so a crash leaves nothing behind for long. Playwright's own temporary browser profiles are written to the system's temporary folder. A browser that is killed (on stop or a time-out) can leave one there; the runner does not delete them, because they cannot be told apart from other programs' files.
- **File cache** (`<work folder>/cache`): baselines and app files, capped by `--cache-mb` (default 2048), least recently used first. Since this round the cap is also applied when the runner starts. Half-finished downloads are removed at start.
- **Outbox** (`<work folder>/outbox`): one small result per task. Each is removed once the platform answers, and dropped after a day.

## On the platform

- **A runner's uploads** (`<project>/_agent/<task>/`) and any local copies (`<scratch>/agent-files/<task>`) are removed with the task 24 h after it finished (`pruneTasks`, at most every 10 minutes).
- **Screenshots, traces and videos** of a finished run are copied into the run's own artifacts. For those 24 h each file exists twice. This is deliberate: the run page's live screenshots point at the uploads.
- **The dispatch worker** waits while the platform's own disk is below `READY_MIN_FREE_MB`, as before.

## Tests

`tests/runner-resources-unit.test.ts` covers:
- the settings;
- the task's process at below-normal priority with a capped heap, and a process it starts inheriting the priority;
- the memory of a process tree, and a tree over its limit reported once;
- the free-space check, with protocol 2 turning the task down and protocol 1 answering `ok: false`;
- the file cache brought within its cap at start;
- a task handed out again while it still runs.

These tests ran on Linux.
