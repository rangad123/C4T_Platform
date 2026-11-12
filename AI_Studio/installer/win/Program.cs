// Entry point: picks between the window, the quiet command-line modes, and the one-copy-at-a-time rule.

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace AITestingRunner
{
    /// <summary>The quiet modes print plain lines, to the console it was started from or to a redirected pipe or file.</summary>
    sealed class ConsoleReport : IReport
    {
        readonly FileLog log;
        readonly Dictionary<string, string> printed = new Dictionary<string, string>();
        public ConsoleReport(FileLog log) { this.log = log; }

        public void Row(StepRow r)
        {
            string key = r.State + "/" + (r.Percent >= 0 ? (r.Percent / 10).ToString() : "-");
            string before;
            if (printed.TryGetValue(r.Id, out before) && before == key) return;
            printed[r.Id] = key;
            if (r.State == S.Checking || r.State == S.Pending) return;
            log.Line(r.Name + ": " + r.StateWord() + (r.Detail.Length > 0 ? ". " + r.Detail : ""));
        }
        public void Log(string line) { log.Line(line); }
        public void Status(string text) { log.Line(text); }
    }

    static class Program
    {
        /// <summary>The copy of this program inside an install folder manages that folder; any other copy manages the default one.</summary>
        static string DefaultRootFor(string exePath)
        {
            string dir = Path.GetDirectoryName(exePath);
            if (File.Exists(Path.Combine(dir, "installer.json")) && File.Exists(Path.Combine(dir, "app", "runner.mjs"))) return dir;
            return Layout.DefaultRoot();
        }

        static string SelfPath() { return System.Reflection.Assembly.GetExecutingAssembly().Location; }

        static string MutexName(Layout lay) { return "Local\\AITP-Runner-" + lay.Key(); }

        [STAThread]
        static int Main(string[] args)
        {
            Net.Init();
            string error;
            Options o = Options.Parse(args, out error);
            bool console = args.Length > 0 && !(args.Length == 1 && args[0] == "--background");
            if (console) AttachConsole();
            if (error != null) { Print("Setup: " + error); return 1; }
            if (o.Help) { Print(Options.Usage); return 0; }

            Layout lay = new Layout(string.IsNullOrEmpty(o.InstallDir) ? DefaultRootFor(System.Reflection.Assembly.GetExecutingAssembly().Location) : o.InstallDir);
            FileLog log = new FileLog();
            if (!string.IsNullOrEmpty(o.LogFile)) log.SetExtra(Path.GetFullPath(o.LogFile));
            if (console || o.NoUi) log.Sink = delegate(string line) { Print(line); };

            try
            {
                if (o.Stop) return RunStop(lay, log);
                if (o.Uninstall) return RunUninstall(o, lay, log);
                // A one-file download carries its kit at its end: unpack it privately and go on as if started from the unzipped folder. The
                // installing modes unpack only after claiming the folder (RunHeadless, RunWindow), so a --stop sent right after the start finds them.
                if (o.Check) Stamp.Unpack(SelfPath(), lay);
                if (o.Check) return RunCheck(o, lay, log);
                if (o.UiSmoke) return UiSmoke.Run(o, lay, log);
                // From here on something may be written to the install folder.
                log.Open(lay.SetupLog);
                if (o.NoUi) return RunHeadless(o, lay, log);
                return RunWindow(o, lay, log);
            }
            catch (Exception e)
            {
                string m = "Setup stopped on an unexpected problem: " + e.Message;
                try { log.Line(m); } catch (Exception) { }
                if (!o.NoUi && !console) { try { MessageBox.Show(m, Product.Name, MessageBoxButtons.OK, MessageBoxIcon.Error); } catch (Exception) { } }
                return 1;
            }
            finally { Stamp.Cleanup(); }
        }

        // ── console plumbing ────────────────────────────────────────────────

        static TextWriter outWriter;
        static void AttachConsole()
        {
            // A program built for windows has no console of its own. If it was started from one, write there; if its output was redirected, that already works.
            IntPtr h = NativeMethods.GetStdHandle(-11);
            bool haveOut = h != IntPtr.Zero && h != new IntPtr(-1);
            if (!haveOut) NativeMethods.AttachConsole(-1);
            try
            {
                StreamWriter w = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
                w.AutoFlush = true;
                outWriter = w;
            }
            catch (Exception) { outWriter = TextWriter.Null; }
        }

        static readonly object printGate = new object();
        static void Print(string line)
        {
            lock (printGate)
            {
                try { if (outWriter != null) outWriter.WriteLine(line); } catch (Exception) { }
            }
        }

        // ── --check ─────────────────────────────────────────────────────────

        static int RunCheck(Options o, Layout lay, FileLog log)
        {
            ConsoleReport rep = new ConsoleReport(log);
            Controller ctl = new Controller(o, lay, rep, new Cancel(), log);
            CheckResult cr = ctl.Check();
            if (cr.CannotContinue) { log.Line(cr.Problem); return 1; }
            if (cr.NeedsDownload) { log.Line("Something would be downloaded: " + Missing(ctl)); return 10; }
            log.Line("Nothing needs to be downloaded.");
            return 0;
        }

        static string Missing(Controller ctl)
        {
            List<string> names = new List<string>();
            foreach (StepRow r in ctl.Rows) if (r.State == S.Missing && r.Id != "files") names.Add(r.Name);
            return string.Join(", ", names.ToArray());
        }

        // ── one copy at a time ──────────────────────────────────────────────

        sealed class Single : IDisposable
        {
            public Mutex Mutex;
            public EventWaitHandle Show, StopEvent;
            public bool Mine;
            public void Dispose()
            {
                try { if (Mine && Mutex != null) Mutex.ReleaseMutex(); } catch (Exception) { }
                if (Mutex != null) Mutex.Close();
                if (Show != null) Show.Close();
                if (StopEvent != null) StopEvent.Close();
            }
        }

        static Single Claim(Layout lay)
        {
            Single s = new Single();
            bool created;
            s.Mutex = new Mutex(true, MutexName(lay), out created);
            s.Mine = created;
            s.Show = new EventWaitHandle(false, EventResetMode.AutoReset, MutexName(lay) + "-show");
            s.StopEvent = new EventWaitHandle(false, EventResetMode.AutoReset, MutexName(lay) + "-stop");
            return s;
        }

        static bool IsRunning(Layout lay)
        {
            try
            {
                bool created;
                using (Mutex m = new Mutex(true, MutexName(lay), out created))
                {
                    if (created) { m.ReleaseMutex(); return false; }
                    return true;
                }
            }
            catch (Exception) { return false; }
        }

        /// <summary>
        /// A one-file download opened while an older copy runs for the same install folder (the common case after every runner was removed:
        /// the old icon says "Access removed"). That copy is asked to close the way --stop asks it (the named stop event every build listens
        /// to), its mutex is waited for, a runner it left is ended (pid and start time checked), and this copy carries on. Null when done.
        /// onMain runs an action on the thread that must own the mutex.
        /// </summary>
        static string TakeOver(Single one, Layout lay, FileLog log, Action<Action> onMain)
        {
            log.Line("Closing the older runner on this computer\u2026");
            one.StopEvent.Set();
            bool free = false;
            DateTime end = DateTime.UtcNow.AddSeconds(60);
            while (!free && DateTime.UtcNow < end)
            {
                try { free = one.Mutex.WaitOne(500); }
                catch (AbandonedMutexException) { free = true; }
            }
            one.StopEvent.Reset();
            if (!free) return "The older runner on this computer did not close. Choose Close this program from its icon next to the clock, then open AITestingRunnerSetup.exe again.";
            // Owned by the thread that waited; hand it to the thread that keeps it (and releases it at the end).
            one.Mutex.ReleaseMutex();
            onMain(delegate
            {
                try { one.Mutex.WaitOne(5000); } catch (AbandonedMutexException) { }
                one.Mine = true;
            });
            RunnerHost.ReapRecorded(lay, log);
            return null;
        }

        static int RunStop(Layout lay, FileLog log)
        {
            if (!IsRunning(lay)) { Print("No copy of the " + Product.Name + " is running for " + lay.Root + "."); return 0; }
            try
            {
                using (EventWaitHandle ev = new EventWaitHandle(false, EventResetMode.AutoReset, MutexName(lay) + "-stop")) ev.Set();
            }
            catch (Exception e) { Print("Could not ask it to stop: " + e.Message); return 1; }
            DateTime end = DateTime.UtcNow.AddSeconds(40);
            while (DateTime.UtcNow < end)
            {
                if (!IsRunning(lay)) { Print("Stopped. The runner was ended and the program closed."); return 0; }
                Thread.Sleep(200);
            }
            Print("It did not stop within 40 seconds.");
            return 1;
        }

        static int RunUninstall(Options o, Layout lay, FileLog log)
        {
            if (IsRunning(lay))
            {
                Print("Stopping the running copy first...");
                if (RunStop(lay, log) != 0) return 1;
            }
            RunnerHost.ReapRecorded(lay, log);
            if (!o.NoUi)
            {
                DialogResult r = MessageBox.Show(
                    "Remove the " + Product.Name + " from this computer?\r\n\r\nThis stops the runner and deletes " + lay.Root + " and the shortcuts this program made. A Node.js that was already installed and the shared browser cache stay.",
                    Product.Name, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
                if (r != DialogResult.Yes) { Print("Nothing was removed."); return 0; }
            }
            Controller ctl = new Controller(o, lay, new ConsoleReport(log), new Cancel(), log);
            bool scheduled;
            foreach (string line in ctl.Uninstall(out scheduled)) Print(line);
            return 0;
        }

        // ── --silent / AITP_INSTALLER_NO_UI ─────────────────────────────────

        static int RunHeadless(Options o, Layout lay, FileLog log)
        {
            using (Single one = Claim(lay))
            {
                Stamp.Unpack(SelfPath(), lay);
                if (!one.Mine && Stamp.Dir == null)
                {
                    Print("The " + Product.Name + " is already running for " + lay.Root + ". Nothing to do.");
                    return 0;
                }
                if (!one.Mine)
                {
                    string why = TakeOver(one, lay, log, delegate(Action a) { a(); });
                    if (why != null) { Print(why); return 1; }
                }
                Cancel cancel = new Cancel();
                Controller ctl = new Controller(o, lay, new ConsoleReport(log), cancel, log);
                RunnerHost host = null;
                volatileFlag stop = new volatileFlag();
                Thread listener = new Thread(delegate()
                {
                    one.StopEvent.WaitOne();
                    stop.Value = true;
                    cancel.Request();
                    RunnerHost h = host;
                    if (h != null) h.Stop();
                });
                listener.IsBackground = true;
                listener.Start();

                string problem = ctl.Install();
                if (stop.Value) return 0;
                if (problem != null) { Print(problem); return 1; }
                // Started at sign-in by default (round 39), like the window's checkbox; --no-start-at-sign-in says not to.
                bool atSignIn = !o.NoStartAtSignIn;
                if (atSignIn || o.StartMenu)
                {
                    try { ctl.ApplyShortcuts(atSignIn, o.StartMenu); }
                    catch (Exception e) { log.Line("Could not add the shortcut: " + e.Message); }
                }
                if (o.NoStart) { log.Line("Installed. The runner was not started (--no-start)."); return 0; }

                host = new RunnerHost(lay, ctl.Node.Path, ctl.PlatformUrl, ctl.RunnerName, log);
                host.Changed += delegate(RunnerStatus s) { log.Line(s.Text); };
                host.Start();
                host.Finished.WaitOne();
                if (stop.Value) return 0;
                int code = host.FinalExitCode;
                return code >= 2 && code <= 5 ? code : (code == 0 ? 0 : 1);
            }
        }

        sealed class volatileFlag { public volatile bool Value; }

        // ── the window ──────────────────────────────────────────────────────

        static int RunWindow(Options o, Layout lay, FileLog log)
        {
            using (Single one = Claim(lay))
            {
                Stamp.Unpack(SelfPath(), lay);
                if (!one.Mine && Stamp.Dir == null)
                {
                    // The runner is already there: bring its window forward.
                    one.Show.Set();
                    return 0;
                }
                UiApp app = null;
                Thread listener = new Thread(delegate()
                {
                    WaitHandle[] both = new WaitHandle[] { one.Show, one.StopEvent };
                    for (;;)
                    {
                        int i = WaitHandle.WaitAny(both);
                        if (i == 0) { try { app.Window.BeginInvoke(new Action(app.ShowWindow)); } catch (Exception) { } }
                        else { app.Quit(0); return; }
                    }
                });
                listener.IsBackground = true;
                // A one-file download replaces an older copy first (TakeOver), in the window; the listener starts once this copy owns the folder.
                if (one.Mine)
                {
                    app = new UiApp(o, lay, log, false, null);
                    listener.Start();
                }
                else
                {
                    app = new UiApp(o, lay, log, false, delegate(UiApp ui)
                    {
                        string why = TakeOver(one, lay, log, ui.OnUiAndWait);
                        if (why == null) listener.Start();
                        return why;
                    });
                }
                Application.Run(app);
                if (app.Host != null) app.Host.Stop();
                return 0;
            }
        }
    }
}
