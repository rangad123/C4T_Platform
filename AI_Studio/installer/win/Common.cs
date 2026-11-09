// AI Testing Runner setup for Windows: shared types and helpers.
//
// Language level: the compiler that ships with Windows (csc 4.8) speaks C# 5 only, so no interpolated strings, no null-conditional dot and no expression-bodied members.
//
// Test-only environment variables (documented in docs/features/runner-installer.md; people never need them):
//   AITP_NODE_DIST_URL                  base address of the Node.js downloads instead of https://nodejs.org/dist (plain http allowed then)
//   AITP_INSTALLER_SKIP_NPM=1           do not run npm install
//   AITP_INSTALLER_NODE_SEARCH_ONLY=a;b look for Node.js only in these folders (and in the private copy)
//   AITP_INSTALLER_NO_UI=1              never open a window or a tray icon, never ask (same as --silent for the questions)
//   AITP_INSTALLER_STARTUP_DIR=<dir>    where the "start when I sign in" shortcut goes instead of the real Startup folder
//   AITP_INSTALLER_STARTMENU_DIR=<dir>  where the Start menu shortcut goes instead of the real one

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace AITestingRunner
{
    static class Product
    {
        public const string Name = "AI Testing Runner";
        public const string SelfName = "AITestingRunner.exe";
        public const int NodeMin = 24;
        /// <summary>Used only when nodejs.org's index cannot be read.</summary>
        public const string PinnedNode = "v24.11.0";
        public const string DefaultDist = "https://nodejs.org/dist";
        public static readonly string[] BundleFiles = { "runner.mjs", "task-child.mjs", "record-child.mjs", "package.json", "LICENSES.txt" };
        public static readonly string[] KitFiles = { "runner.json" };
        /// <summary>Copied when the download has them: the test tools' lock file, and the credential (a one-time code, or an older download's token).</summary>
        public static readonly string[] OptionalFiles = { "package-lock.json", "runner.enroll", "runner.token" };
        /// <summary>The file that asks the runner to stop gracefully (src/agent/stop-file.ts), and how long to wait before ending it hard.</summary>
        public const string StopFile = "stop.request";
        public const int StopGraceMs = 25000;
    }

    static class Env
    {
        public static string Get(string name)
        {
            string v = Environment.GetEnvironmentVariable(name);
            return v == null ? "" : v.Trim();
        }
        public static bool On(string name) { return Get(name) == "1"; }
    }

    sealed class Options
    {
        public bool Check, Silent, NoStart, Uninstall, Stop, Help, UiSmoke, Background, StartAtSignIn, NoStartAtSignIn, StartMenu, AllBrowsers;
        public string InstallDir = "", LogFile = "", Screenshot = "";

        public bool NoUi { get { return Silent || Env.On("AITP_INSTALLER_NO_UI"); } }

        public static Options Parse(string[] args, out string error)
        {
            Options o = new Options();
            error = null;
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                string lower = a.ToLowerInvariant();
                switch (lower)
                {
                    case "--check": o.Check = true; break;
                    case "--silent": o.Silent = true; break;
                    case "--no-start": o.NoStart = true; break;
                    case "--uninstall": o.Uninstall = true; break;
                    case "--stop": o.Stop = true; break;
                    case "--background": o.Background = true; break;
                    case "--start-at-sign-in": o.StartAtSignIn = true; break;
                    case "--no-start-at-sign-in": o.NoStartAtSignIn = true; break;
                    case "--start-menu": o.StartMenu = true; break;
                    case "--all-browsers": o.AllBrowsers = true; break;
                    case "--ui-smoke": o.UiSmoke = true; break;
                    case "--help": case "-h": case "/?": o.Help = true; break;
                    case "--install-dir":
                    case "--log":
                    case "--screenshot":
                        if (i + 1 >= args.Length || args[i + 1].StartsWith("--")) { error = a + " needs a value."; return o; }
                        string val = args[++i];
                        if (lower == "--install-dir") o.InstallDir = val;
                        else if (lower == "--log") o.LogFile = val;
                        else o.Screenshot = val;
                        break;
                    default:
                        error = "I do not know the option " + a + ". Run with --help to see the options.";
                        return o;
                }
            }
            return o;
        }

        public const string Usage =
            "AI Testing Runner setup\r\n" +
            "\r\n" +
            "Double-click to set up and start the runner. For administrators and tests:\r\n" +
            "  --check               print what is installed and what would be downloaded, then exit (0 nothing to download, 10 something would be, 1 error)\r\n" +
            "  --silent              no window: install what is missing, start the runner and keep running\r\n" +
            "  --no-start            install but do not start the runner\r\n" +
            "  --stop                ask a running copy for this install folder to stop its runner and exit\r\n" +
            "  --uninstall           stop the runner and remove what this program installed\r\n" +
            "  --install-dir <path>  install here instead of %LOCALAPPDATA%\\AITestingRunner\r\n" +
            "  --log <file>          also write the output to this file\r\n" +
            "  --background          start with only the notification-area icon when nothing is missing\r\n" +
            "  --start-at-sign-in    add a shortcut to the Startup folder (silent installs do by default)\r\n" +
            "  --no-start-at-sign-in do not start the runner when you sign in (silent installs)\r\n" +
            "  --start-menu          add a Start menu shortcut (silent installs)\r\n" +
            "  --all-browsers        accepted for older shortcuts and ignored: the runner downloads Firefox and WebKit itself when a run needs them\r\n" +
            "Exit codes: 0 done, 1 failed, 10 (with --check) something would be downloaded, 2 to 5 the runner stopped for a reason a restart cannot fix.\r\n";
    }

    /// <summary>Where everything lives. Nothing outside this folder is written, except the shortcuts the person asked for.</summary>
    sealed class Layout
    {
        public readonly string Root, App, NodeDir, Logs, Downloads, StateFile, SelfCopy, RunnerLog, SetupLog;

        public Layout(string root)
        {
            Root = Path.GetFullPath(root);
            App = Path.Combine(Root, "app");
            NodeDir = Path.Combine(Root, "node");
            Logs = Path.Combine(Root, "logs");
            Downloads = Path.Combine(Root, "downloads");
            StateFile = Path.Combine(Root, "installer.json");
            SelfCopy = Path.Combine(Root, Product.SelfName);
            RunnerLog = Path.Combine(Logs, "runner.log");
            SetupLog = Path.Combine(Logs, "setup.log");
        }

        public static string DefaultRoot()
        {
            string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
            if (string.IsNullOrEmpty(local)) local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "AppData", "Local");
            return Path.Combine(local, "AITestingRunner");
        }

        public string Key() { return Util.Sha256Text(Root.TrimEnd('\\').ToLowerInvariant()).Substring(0, 16); }
        public string StartupDir() { string o = Env.Get("AITP_INSTALLER_STARTUP_DIR"); return o.Length > 0 ? o : Environment.GetFolderPath(Environment.SpecialFolder.Startup); }
        public string StartMenuDir() { string o = Env.Get("AITP_INSTALLER_STARTMENU_DIR"); return o.Length > 0 ? o : Environment.GetFolderPath(Environment.SpecialFolder.Programs); }
        public string StartupLink() { return Path.Combine(StartupDir(), Product.Name + ".lnk"); }
        public string StartMenuLink() { return Path.Combine(StartMenuDir(), Product.Name + ".lnk"); }
    }

    /// <summary>One line on the checklist.</summary>
    enum S { Pending, Checking, Found, Missing, Downloading, Installing, Done, Failed, Skipped, Checked }

    sealed class StepRow
    {
        public string Id, Name, Detail = "";
        public S State = S.Pending;
        public int Percent = -1;

        public StepRow(string id, string name) { Id = id; Name = name; }
        public StepRow Copy() { return (StepRow)MemberwiseClone(); }

        public static string Word(S s, int percent)
        {
            return Word(s, percent, "download");
        }

        public static string Word(S s, int percent, string verb)
        {
            switch (s)
            {
                case S.Pending: return "Waiting";
                case S.Checking: return "Checking";
                case S.Found: return "Found, skipped";
                case S.Missing: return verb == "copy" ? "Out of date, will copy" : verb == "bundled" ? "In this download, will copy" : "Missing, will download";
                case S.Downloading: return percent >= 0 ? "Downloading " + percent + "%" : "Downloading";
                case S.Installing: return "Installing";
                case S.Done: return "Done";
                case S.Failed: return "Failed";
                case S.Checked: return "Checked";
                default: return "Skipped";
            }
        }
        /// <summary>True when what this row needs came with a complete download (its own Node.js or test tools): copied, never downloaded.</summary>
        public bool FromKit;
        public string StateWord() { return Word(State, Percent, Id == "files" ? "copy" : FromKit ? "bundled" : "download"); }
    }

    interface IReport
    {
        void Row(StepRow row);
        void Log(string line);
        void Status(string text);
    }

    /// <summary>Lets the person (or the --stop switch) interrupt long work. Kills only the processes this program started.</summary>
    sealed class Cancel
    {
        volatile bool requested;
        readonly object gate = new object();
        readonly List<Process> running = new List<Process>();

        public bool Requested { get { return requested; } }

        public void Request()
        {
            requested = true;
            lock (gate) { foreach (Process p in running) Util.KillTree(p); }
        }

        public void Track(Process p) { lock (gate) { running.Add(p); } if (requested) Util.KillTree(p); }
        public void Untrack(Process p) { lock (gate) { running.Remove(p); } }
        public void ThrowIfRequested() { if (requested) throw new OperationCanceledException("Cancelled."); }
    }

    /// <summary>A problem the person can understand, with what to do about it.</summary>
    sealed class PlainException : Exception
    {
        public PlainException(string message) : base(message) { }
    }

    static class Util
    {
        public static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);

        public static string Sha256Text(string s) { return Sha256Bytes(Utf8.GetBytes(s)); }

        public static string Sha256Bytes(byte[] b)
        {
            using (SHA256 h = SHA256.Create()) return Hex(h.ComputeHash(b));
        }

        public static string Sha256File(string file)
        {
            using (SHA256 h = SHA256.Create())
            using (FileStream f = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16))
                return Hex(h.ComputeHash(f));
        }

        public static string Hex(byte[] bytes)
        {
            StringBuilder sb = new StringBuilder(bytes.Length * 2);
            foreach (byte b in bytes) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }

        public static bool SameFile(string a, string b)
        {
            try
            {
                FileInfo fa = new FileInfo(a), fb = new FileInfo(b);
                if (!fa.Exists || !fb.Exists || fa.Length != fb.Length) return false;
                return Sha256File(a) == Sha256File(b);
            }
            catch (IOException) { return false; }
            catch (UnauthorizedAccessException) { return false; }
        }

        public static bool SamePath(string a, string b)
        {
            try { return string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase); }
            catch (Exception) { return false; }
        }

        public static bool IsUnder(string child, string parent)
        {
            string c = Path.GetFullPath(child).TrimEnd('\\') + "\\";
            string p = Path.GetFullPath(parent).TrimEnd('\\') + "\\";
            return c.StartsWith(p, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// A Windows program by its full path in System32, so a file of the same name in this program's own folder (often Downloads) or in the
        /// current folder is never started in its place. The bare name only if System32 does not have it.
        /// </summary>
        public static string SystemTool(string exe)
        {
            string p = Path.Combine(Environment.SystemDirectory, exe);
            return File.Exists(p) ? p : exe;
        }

        /// <summary>Stops a process this program started, and the processes it started.</summary>
        public static void KillTree(Process p)
        {
            try
            {
                if (p == null || p.HasExited) return;
                ProcessStartInfo psi = new ProcessStartInfo(SystemTool("taskkill.exe"), "/PID " + p.Id + " /T /F");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                using (Process k = Process.Start(psi)) { if (k != null) k.WaitForExit(15000); }
            }
            catch (Exception) { /* already gone */ }
            try { if (!p.HasExited) p.Kill(); } catch (Exception) { }
        }

        public sealed class Captured { public int Code = -1; public string Out = ""; public bool TimedOut, Started; }

        /// <summary>Runs a short command and returns its output. Never shows a window.</summary>
        public static Captured Run(string file, string args, int timeoutMs, string workDir, IDictionary<string, string> env)
        {
            Captured r = new Captured();
            ProcessStartInfo psi = new ProcessStartInfo(file, args);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Utf8;
            if (!string.IsNullOrEmpty(workDir)) psi.WorkingDirectory = workDir;
            if (env != null) foreach (KeyValuePair<string, string> kv in env) psi.EnvironmentVariables[kv.Key] = kv.Value;
            try
            {
                using (Process p = Process.Start(psi))
                {
                    r.Started = true;
                    StringBuilder sb = new StringBuilder();
                    p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) lock (sb) sb.AppendLine(e.Data); };
                    p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { };
                    p.BeginOutputReadLine();
                    p.BeginErrorReadLine();
                    if (!p.WaitForExit(timeoutMs)) { r.TimedOut = true; KillTree(p); p.WaitForExit(5000); }
                    else p.WaitForExit();
                    r.Code = r.TimedOut ? -1 : p.ExitCode;
                    lock (sb) r.Out = sb.ToString();
                }
            }
            catch (Exception) { /* not started */ }
            return r;
        }

        /// <summary>Runs a long command, passing every output line on, until it ends, is cancelled, or the time is up. Returns the exit code, or -1.</summary>
        public static int RunStreaming(string file, string args, string workDir, IDictionary<string, string> env, Action<string> onLine, int timeoutMs, Cancel cancel, out bool timedOut)
        {
            timedOut = false;
            ProcessStartInfo psi = new ProcessStartInfo(file, args);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Utf8;
            psi.StandardErrorEncoding = Utf8;
            psi.WorkingDirectory = workDir;
            if (env != null) foreach (KeyValuePair<string, string> kv in env) psi.EnvironmentVariables[kv.Key] = kv.Value;
            using (Process p = Process.Start(psi))
            {
                cancel.Track(p);
                try
                {
                    DataReceivedEventHandler h = delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) onLine(e.Data); };
                    p.OutputDataReceived += h;
                    p.ErrorDataReceived += h;
                    p.BeginOutputReadLine();
                    p.BeginErrorReadLine();
                    if (!p.WaitForExit(timeoutMs)) { timedOut = true; KillTree(p); p.WaitForExit(5000); return -1; }
                    p.WaitForExit();
                    return cancel.Requested ? -1 : p.ExitCode;
                }
                finally { cancel.Untrack(p); }
            }
        }

        public static string Quote(string s) { return "\"" + s.Replace("\"", "\\\"") + "\""; }

        public static string Json(string s)
        {
            StringBuilder sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c < 32) sb.Append("\\u" + ((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }

        public static Dictionary<string, object> ReadJson(string file)
        {
            try
            {
                JavaScriptSerializer js = new JavaScriptSerializer();
                js.MaxJsonLength = int.MaxValue;
                string text = File.ReadAllText(file, Utf8);
                if (text.Length > 0 && text[0] == '﻿') text = text.Substring(1);
                return js.Deserialize<Dictionary<string, object>>(text);
            }
            catch (Exception) { return null; }
        }

        public static string Str(Dictionary<string, object> d, string key)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v) && v != null) return Convert.ToString(v);
            return "";
        }

        /// <summary>Deletes a folder tree without ever following a junction or symbolic link out of it (a link is removed, its target is left alone).</summary>
        public static void DeleteTree(string dir)
        {
            if (!Directory.Exists(dir)) return;
            DirectoryInfo di = new DirectoryInfo(dir);
            if ((di.Attributes & FileAttributes.ReparsePoint) != 0) { di.Delete(false); return; }
            foreach (FileSystemInfo child in di.GetFileSystemInfos())
            {
                if ((child.Attributes & FileAttributes.ReparsePoint) != 0)
                {
                    if (child is DirectoryInfo) ((DirectoryInfo)child).Delete(false);
                    else { child.Attributes = FileAttributes.Normal; child.Delete(); }
                }
                else if (child is DirectoryInfo) DeleteTree(child.FullName);
                else { child.Attributes = FileAttributes.Normal; child.Delete(); }
            }
            di.Attributes = FileAttributes.Normal;
            di.Delete(false);
        }

        /// <summary>Copies a folder tree into `to` (files and folders; a linked folder inside is not followed). Returns how many files were copied.</summary>
        public static int CopyTree(string from, string to, Cancel c)
        {
            Directory.CreateDirectory(to);
            int n = 0;
            foreach (string d in Directory.GetDirectories(from))
            {
                DirectoryInfo di = new DirectoryInfo(d);
                if ((di.Attributes & FileAttributes.ReparsePoint) != 0) continue;
                n += CopyTree(d, Path.Combine(to, di.Name), c);
            }
            foreach (string f in Directory.GetFiles(from))
            {
                if (c != null) c.ThrowIfRequested();
                File.Copy(f, Path.Combine(to, Path.GetFileName(f)), true);
                n++;
            }
            return n;
        }

        /// <summary>
        /// DeleteTree, tried again for a few seconds: on Windows a file another program still holds (an antivirus scan, the search indexer,
        /// a process that is just exiting) is only marked for deletion, so its folder cannot be removed yet and would be left behind, empty.
        /// Throws the last error when it still cannot.
        /// </summary>
        public static void DeleteTreeRetrying(string dir)
        {
            for (int i = 0; ; i++)
            {
                try { DeleteTree(dir); return; }
                catch (Exception) { if (i >= 15) throw; Thread.Sleep(400); }
            }
        }

        public static void DeleteTreeQuietly(string dir)
        {
            for (int i = 0; i < 4; i++)
            {
                try { DeleteTree(dir); return; }
                catch (Exception) { Thread.Sleep(300); }
            }
        }

        public static string Hostname(string url)
        {
            try { return new Uri(url).Host; } catch (Exception) { return url; }
        }
    }

    /// <summary>The program's own log: setup.log in the install folder, plus whatever the caller wants (console, window).</summary>
    sealed class FileLog
    {
        readonly object gate = new object();
        string file;
        string extra;
        public Action<string> Sink;

        public void Open(string path) { file = path; }
        public void SetExtra(string path) { extra = path; }

        public void Line(string text)
        {
            string stamped = DateTime.Now.ToString("HH:mm:ss") + " " + text;
            lock (gate)
            {
                Append(file, stamped);
                Append(extra, stamped);
            }
            Action<string> s = Sink;
            if (s != null) { try { s(text); } catch (Exception) { } }
        }

        static void Append(string path, string line)
        {
            if (string.IsNullOrEmpty(path)) return;
            try
            {
                string dir = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                File.AppendAllText(path, line + "\r\n", Util.Utf8);
            }
            catch (Exception) { /* a log that cannot be written must not stop the program */ }
        }
    }
}
