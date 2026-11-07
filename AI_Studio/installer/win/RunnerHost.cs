// Runs the runner as a hidden child process and keeps it running: restarts it after a crash with a pause (like start-runner.cmd), stops for
// the reasons a restart cannot fix (exit codes 2 to 5), and records the process it started so that it, and only it, can be stopped later.
// The child lives in a job object, so it cannot outlive this program: if this program ends for any reason, Windows ends the runner too.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace AITestingRunner
{
    enum RunnerPhase { NotStarted, Starting, Connected, NotConnected, Stopped, AccessRemoved, NeedsAttention }

    sealed class RunnerStatus
    {
        public RunnerPhase Phase;
        public string Text = "";
        public int ExitCode;      // meaningful for Stopped / AccessRemoved / NeedsAttention
    }

    sealed class RunnerHost
    {
        readonly Layout lay;
        readonly string nodePath, platformUrl, runnerName;
        readonly FileLog log;
        readonly object gate = new object();
        Thread loop;
        Process child;
        IntPtr job = IntPtr.Zero;
        volatile bool stopRequested;
        readonly ManualResetEvent wake = new ManualResetEvent(false);
        const int StartFailed = -1000;
        public volatile int FinalExitCode = -1;
        public event Action<RunnerStatus> Changed;
        public RunnerStatus Status = new RunnerStatus();
        public readonly ManualResetEvent Finished = new ManualResetEvent(false);

        public RunnerHost(Layout lay, string nodePath, string platformUrl, string runnerName, FileLog log)
        {
            this.lay = lay;
            this.nodePath = nodePath;
            this.platformUrl = platformUrl;
            this.runnerName = runnerName;
            this.log = log;
        }

        public bool Running { get { return loop != null && loop.IsAlive; } }

        void Set(RunnerPhase phase, string text, int code)
        {
            RunnerStatus s = new RunnerStatus();
            s.Phase = phase; s.Text = text; s.ExitCode = code;
            Status = s;
            Action<RunnerStatus> h = Changed;
            if (h != null) { try { h(s); } catch (Exception) { } }
        }

        public void Start()
        {
            if (Running) return;
            stopRequested = false;
            FinalExitCode = -1;
            Finished.Reset();
            wake.Reset();
            ReapEarlierRunner();
            // A stop request left by an earlier session must not stop this start.
            try { File.Delete(Path.Combine(lay.App, Product.StopFile)); } catch (Exception) { }
            Set(RunnerPhase.Starting, "Starting the runner", 0);
            loop = new Thread(Loop);
            loop.IsBackground = true;
            loop.Name = "runner-supervisor";
            loop.Start();
        }

        public void Stop()
        {
            stopRequested = true;
            wake.Set();
            StopChildGracefully();
            Thread t = loop;
            if (t != null && t.IsAlive && Thread.CurrentThread != t) t.Join(15000);
        }

        void Loop()
        {
            int code = 0;
            while (!stopRequested)
            {
                code = RunOnce();
                if (stopRequested) break;
                if (code == StartFailed) { code = 1; break; }
                if (code == 0) { Set(RunnerPhase.Stopped, "The runner stopped", 0); break; }
                if (code == 2) { Set(RunnerPhase.NeedsAttention, "The runner could not read its settings. Check that you unzipped the whole kit, or download a new one from the platform.", 2); break; }
                if (code == 3) { Set(RunnerPhase.AccessRemoved, "The platform no longer accepts this runner. It was removed, its one-time code was already used or has expired, or the project was deleted. Make a new download on the Runners page of the platform.", 3); break; }
                if (code == 4) { Set(RunnerPhase.NeedsAttention, "This runner and the platform are different versions. Download a new runner from the platform.", 4); break; }
                if (code == 5) { Set(RunnerPhase.NeedsAttention, "The platform refused this runner. The log says why.", 5); break; }
                // 75: the runner switched to a new version of itself (docs/features/runner-updates.md); start it again at once.
                if (code == 75) { Set(RunnerPhase.Starting, "The runner updated itself. Starting the new version", 0); log.Line("The runner updated itself. Starting the new version."); continue; }
                Set(RunnerPhase.NotConnected, "The runner stopped unexpectedly (code " + code + "). Starting it again in 5 seconds", code);
                log.Line("The runner stopped unexpectedly (code " + code + "). Starting it again in 5 seconds.");
                wake.WaitOne(5000);
            }
            FinalExitCode = stopRequested ? 0 : code;
            ClearRecordedPid();
            Finished.Set();
        }

        int RunOnce()
        {
            Process p;
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(nodePath, "runner.mjs" + CredentialArgs(lay.App));
                psi.WorkingDirectory = lay.App;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Util.Utf8;
                psi.StandardErrorEncoding = Util.Utf8;
                string path = Environment.GetEnvironmentVariable("PATH") ?? "";
                psi.EnvironmentVariables["PATH"] = Path.GetDirectoryName(nodePath) + ";" + path;
                p = Process.Start(psi);
            }
            catch (Exception e)
            {
                Set(RunnerPhase.NeedsAttention, "The runner could not be started: " + e.Message, 1);
                log.Line("The runner could not be started: " + e.Message);
                return StartFailed;
            }
            lock (gate) { child = p; }
            AssignToJob(p);
            RecordPid(p);
            log.Line("Runner started (process " + p.Id + ").");
            Set(RunnerPhase.Starting, "Starting the runner", 0);
            DataReceivedEventHandler h = delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) OnLine(e.Data); };
            p.OutputDataReceived += h;
            p.ErrorDataReceived += h;
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            p.WaitForExit();
            p.WaitForExit(); // lets the output handlers finish
            int code = p.ExitCode;
            lock (gate) { child = null; }
            ClearRecordedPid();
            log.Line("Runner ended with code " + code + ".");
            return code;
        }

        /// <summary>
        /// How the runner finds its credential: a one-time code it trades for its own credential and then deletes (runner.enroll), an older
        /// download's runner.token, or nothing (the runner reads the credential it keeps protected for this Windows user).
        /// </summary>
        public static string CredentialArgs(string appDir)
        {
            if (File.Exists(Path.Combine(appDir, "runner.enroll"))) return " --enroll-file runner.enroll";
            if (File.Exists(Path.Combine(appDir, "runner.token"))) return " --token-file runner.token";
            return "";
        }

        static readonly Regex Warn = new Regex(@"^\S+\s+(WARN|ERROR)\s+(.*)$");

        void OnLine(string line)
        {
            AppendRunnerLog(line);
            if (line.IndexOf("Connected to the platform", StringComparison.Ordinal) >= 0)
                Set(RunnerPhase.Connected, "Connected to " + Util.Hostname(platformUrl) + " as " + runnerName, 0);
            else
            {
                Match m = Warn.Match(line);
                if (m.Success && m.Groups[2].Value.IndexOf("Trying again", StringComparison.Ordinal) >= 0)
                    Set(RunnerPhase.NotConnected, "Not connected: " + Shorten(m.Groups[2].Value), 0);
            }
        }

        static string Shorten(string s)
        {
            int i = s.IndexOf(" Trying again", StringComparison.Ordinal);
            if (i > 0) s = s.Substring(0, i);
            return s.Length > 160 ? s.Substring(0, 157) + "..." : s;
        }

        readonly object logGate = new object();
        void AppendRunnerLog(string line)
        {
            lock (logGate)
            {
                try
                {
                    Directory.CreateDirectory(lay.Logs);
                    FileInfo fi = new FileInfo(lay.RunnerLog);
                    if (fi.Exists && fi.Length > 2 * 1024 * 1024)
                    {
                        string old = lay.RunnerLog + ".1";
                        if (File.Exists(old)) File.Delete(old);
                        File.Move(lay.RunnerLog, old);
                    }
                    File.AppendAllText(lay.RunnerLog, line + "\r\n", Util.Utf8);
                }
                catch (Exception) { }
            }
        }

        // ── the process this program started, and only that ─────────────────

        /// <summary>
        /// Ask the runner to stop (the stop file it watches, src/agent/stop-file.ts): it reports its running test as stopped and exits. Only
        /// when it is still there after 25 seconds is it ended hard, with everything it started (the job object).
        /// </summary>
        void StopChildGracefully()
        {
            Process p;
            lock (gate) { p = child; }
            if (p == null) return;
            string request = Path.Combine(lay.App, Product.StopFile);
            bool asked = false;
            try
            {
                File.WriteAllText(request, DateTime.UtcNow.ToString("o") + "\r\n", Util.Utf8);
                asked = true;
                log.Line("Asked the runner to stop. It reports its running test first.");
            }
            catch (Exception e) { log.Line("Could not ask the runner to stop gently (" + e.Message + "). Ending it now."); }
            bool exited = false;
            if (asked)
            {
                try { exited = p.WaitForExit(Product.StopGraceMs); } catch (Exception) { exited = true; }
                if (!exited) log.Line("The runner did not stop within " + (Product.StopGraceMs / 1000) + " seconds. Ending it now.");
            }
            if (!exited) KillChild();
            try { File.Delete(request); } catch (Exception) { }
        }

        void KillChild()
        {
            Process p;
            lock (gate) { p = child; }
            if (p == null) return;
            if (job != IntPtr.Zero) { try { NativeMethods.TerminateJobObject(job, 1); } catch (Exception) { } }
            Util.KillTree(p);
        }

        void RecordPid(Process p)
        {
            try
            {
                InstallState s = InstallState.Load(lay);
                s.RunnerPid = p.Id;
                s.RunnerStart = p.StartTime.ToUniversalTime().Ticks.ToString();
                s.Save(lay);
            }
            catch (Exception) { }
        }

        void ClearRecordedPid()
        {
            try
            {
                if (!File.Exists(lay.StateFile)) return;
                InstallState s = InstallState.Load(lay);
                if (s.RunnerPid == 0) return;
                s.RunnerPid = 0;
                s.RunnerStart = "";
                s.Save(lay);
            }
            catch (Exception) { }
        }

        /// <summary>
        /// A runner started by an earlier copy of this program that was ended without cleaning up. It is ended only if the recorded process id is
        /// still the same process (same start time) and is a node.exe: a reused process id belonging to anything else is never touched.
        /// </summary>
        public static bool ReapRecorded(Layout lay, FileLog log)
        {
            try
            {
                InstallState s = InstallState.Load(lay);
                if (s.RunnerPid <= 0 || s.RunnerStart.Length == 0) return false;
                Process p;
                try { p = Process.GetProcessById(s.RunnerPid); } catch (ArgumentException) { return false; }
                using (p)
                {
                    long ticks;
                    if (!long.TryParse(s.RunnerStart, out ticks)) return false;
                    long actual = p.StartTime.ToUniversalTime().Ticks;
                    if (Math.Abs(actual - ticks) > TimeSpan.TicksPerSecond * 2) return false;
                    if (!string.Equals(p.ProcessName, "node", StringComparison.OrdinalIgnoreCase)) return false;
                    log.Line("Ending the runner an earlier session left running (process " + p.Id + ").");
                    Util.KillTree(p);
                    return true;
                }
            }
            catch (Exception) { return false; }
        }

        void ReapEarlierRunner() { ReapRecorded(lay, log); }

        // ── job object ──────────────────────────────────────────────────────

        void AssignToJob(Process p)
        {
            try
            {
                if (job == IntPtr.Zero)
                {
                    job = NativeMethods.CreateJobObject(IntPtr.Zero, null);
                    NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                    info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    int len = Marshal.SizeOf(typeof(NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                    IntPtr ptr = Marshal.AllocHGlobal(len);
                    try
                    {
                        Marshal.StructureToPtr(info, ptr, false);
                        NativeMethods.SetInformationJobObject(job, 9, ptr, (uint)len);
                    }
                    finally { Marshal.FreeHGlobal(ptr); }
                }
                NativeMethods.AssignProcessToJobObject(job, p.Handle);
            }
            catch (Exception) { /* without a job the runner is still stopped through its process tree */ }
        }
    }

    static class NativeMethods
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateJobObject(IntPtr attrs, string name);
        [DllImport("kernel32.dll")]
        public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size);
        [DllImport("kernel32.dll")]
        public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")]
        public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll")]
        public static extern bool AttachConsole(int pid);
        [DllImport("kernel32.dll")]
        public static extern IntPtr GetStdHandle(int which);

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct IO_COUNTERS
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }
    }
}
