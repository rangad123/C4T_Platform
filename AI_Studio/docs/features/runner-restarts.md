# Runs on runners across a platform restart

A run that is going on a runner does not need the platform process that started it. A deploy or a crash of the platform therefore no longer stops it. A test is never run twice at once, and a test the runner already ran, or is running, is not run again as long as what would be sent is exactly what was sent ("When a test can run a second time" below says when it is not).

## A deploy (graceful stop: SIGTERM or SIGINT)

1. The platform stops taking work, as before (`/readyz` answers 503, the scheduler stops).
2. It **drains** runner work (`AgentService.drain`): nothing new is handed to a runner, and open long polls end at once, so the stop does not wait up to a poll's length for them.
3. Every job that is waiting for a runner **parks** where it is. The runner is told nothing and keeps running. The job is **handed over** on the first park (`src/platform/runner-handover.ts`), in this order, so that nothing of this attempt is written after its lease is released, even when several tests of the job are going at once (`CONCURRENCY` above 1):
   - no new write for the job starts any more: the engine's calls on the job's sink, its events and the runner executor's own writes are refused, and the part of the job that made them stops right there (`isHandedOver`, `fenceSink` in `job-runner.ts`); a finished runner result is no longer collected (the next process collects it);
   - the writes already going (for example another test's result being stored) are waited for, and the job's write queue is flushed;
   - its tests that have no result yet go back to what they were before the run;
   - an event says so (`job_handed_over`), and the job's write queue is closed;
   - its lease is released at once with the mark `handed-over`, and the attempt is not counted as a lost one.
4. A job doing anything else (in local mode, a run with a browser on the server) is waited for and, after `SHUTDOWN_GRACE_SECONDS`, stopped as before.

A deploy therefore takes a second or two instead of up to `SHUTDOWN_GRACE_SECONDS` while runs are on runners.

## When the platform starts again

- Every running runner task gets one full task lease (`AGENT_LEASE_SECONDS`) from the start before it can count as lost. While the platform was away, runners could not report, and they reconnect within their back-off (30 s at most).
- A handed-over job goes back to the queue straight away, whatever its attempt count. The `runner_job_resumed` event says so.
- A job whose platform process died without stopping (a crash) is re-queued when its 60 s job lease runs out, as before. Its runner task is **kept** if it is still alive (`runner_attempt_kept`). It is cancelled only when the job is given up (the third loss) or the project no longer runs on runners.
- The job runs again. When it reaches the scripts it had sent, its executor **picks up the earlier runner task** instead of sending a new one (`runner_task_resumed`). The earlier task matches only when what would be sent now is exactly what was sent (`batchKey` in `agent-services.ts`, made from the task offer on both sides):
  - the same framework;
  - for each script: the same test, file name and content (sha256), the same code-script and signed-in flags, and the same baseline images and test files (sha256);
  - the same helpers (sha256);
  - the same environment without its secret values: the address and the API address, headed or not, cleanup, the variables, the account user names and role names, and whether a password's authenticator secret, an API token, an auth header (by its name) and a saved sign-in are there;
  - the same phone or iOS part (app package, emulator, device choice, the app file by its sha256; bundle and simulator);
  - the same browser variants, each with its device and screen size.

  Only the task's id, its time limits and the secret values are not compared: a fetched API token, a refreshed saved sign-in or a changed password is still the same work. The task must be:
  - still queued;
  - running and not being stopped; or
  - finished with its result stored (that result is used, and its cleanup ledger is not stored a second time).
- The task keeps its id and its protocol-2 attempt id, so fencing is unchanged, and protocol-1 runners see no difference.
- When the new attempt sends tests that an earlier task it did not pick up still holds (for example, a script changed in between), that earlier task is stopped first, and the new attempt waits until it has really stopped before it sends anything: a test never runs twice at once. Earlier tasks that hold none of these tests are left alone: the attempt picks them up when it gets to their tests, and any it never gets to are stopped when the job ends (the sweep's rule for a finished job).
- A task that is really lost (no heartbeat for a full lease after the start) follows the usual rules: it is offered once more, then fails.

## When a test can run a second time

Never at the same time. One after the other, only when:

- what would be sent changed between the attempts: the test's script (a generate job writes its tests again after a restart; a person edits a test, approves a version, or changes a shared element, a reusable block or a helper while the platform restarts), its flags, baselines or test files, the helpers, the environment's address, variables or accounts, the phone or iOS settings, or the variants. The earlier task is stopped (if it still runs) and the new script runs. A result is never attached to a script that did not run;
- the earlier task held this test together with a test whose script changed (one task can hold several tests): the whole earlier task is stopped, and both tests run again;
- the earlier task was really lost (no heartbeat for a full lease), or a person or the job's time limit stopped it;
- the job was given up (the third lost attempt) and someone starts it again.

A test the new attempt never gets to (it stops at the first failure, or the test was removed meanwhile) may still finish on the runner; its result is not used, and its task is stopped when the job ends.

## On the runner

- If the platform hands out a task again that is still running on this computer, the earlier run is stopped first. Its process tree is killed, it sends no result, and its folder is removed. Only then does the new run start (`TaskRunner.run`). This can happen when the platform stopped hearing from the run and its lease ran out.
- A result finished while the platform was away waits in the outbox and is sent when the platform answers, as before. With the pick-up above, that result now completes the run.

## Limits

- A job is picked up again where its runner task is. The engine itself starts the job again: scripts are rendered again and results recorded so far are recorded again from the stored result (a test's history can show the same execution twice). The cleanup ledger of a task is stored once, and a trace that was not kept the first time is not reported again as never uploaded.
- A **run sequence** (runbook) is not resumed. At a deploy it ends as interrupted; the test run of its current step is not stopped when it already runs on a runner: it is handed over and finishes on its own, and the step says so. The steps after it are not run.
- A crash is noticed only when the job's 60 s lease runs out.
- Recordings, live sessions and phone sessions still end with a restart; they live in the platform's memory.
- A standalone worker process (`npm run worker`) hands its runner jobs over the same way when it is stopped.

## Tests

- `tests/runner-restart.test.ts`: the real program in runners mode, stopped and started on the same data folder while a runner holds a task:
  - a deploy, with a protocol-1 runner;
  - a crash, with a protocol-2 runner;
  - a crash where the result arrives before the job is picked up again.

  Each case checks that the job has one task, the runner got one offer, no heartbeat answer said cancel, and the job completed with the runner's results.
- `tests/runner-only-mode.test.ts`: a re-queued job keeps the earlier task; giving the job up cancels it.
- `tests/runner-handover.test.ts` (in one process, no port):
  - a changed script, baseline, code-script or signed-in flag, or helper sends a new task; exactly the same work is picked up with its stored result;
  - a changed variable, account user name, API address, headed setting, variant device or screen size sends a new task; a new password or API token is still picked up;
  - a new attempt stops only the earlier task of the test it sends; the earlier task of another test is picked up later, not run again;
  - a finished task picked up again stores its cleanup ledger once and does not report its withheld trace as never uploaded;
  - a run sequence stopped by a deploy leaves its step's runner job alone;
  - a job with two tests going at once is handed over atomically: the write still going is stored before the lease is released, and nothing is written after it; the closed write queue and the fenced sink on their own.
- `tests/runner-resources-unit.test.ts`: a task handed out again while it still runs is never run twice at once on the runner, and only one result is sent.
