// The checklist: what is already on this computer, what is missing, and doing something about it. Used by the window, by --check and by --silent.
// Every step first looks (Check) and only does work when something is missing (Install), so a second run costs about a second.

using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;

namespace AITestingRunner
{
    /// <summary>What the installer wrote down about itself (installer.json): enough to uninstall exactly what it created and nothing else.</summary>
    sealed class InstallState
    {
        public string Node = "";          // "private" when this program downloaded Node.js, "found" when it used one that was already there
        public string NodePath = "";
        public bool StartupShortcut, StartMenuShortcut;
        public int RunnerPid;
        public string RunnerStart = "";   // the start time (UTC ticks) of that process, so a reused process id is never mistaken for it
        public string CreatedAt = "";
        public string EnrollSha = "";     // the sha256 of the last one-time code copied (never the code), so a used code is not copied again

        public static InstallState Load(Layout lay)
        {
            InstallState s = new InstallState();
            Dictionary<string, object> d = Util.ReadJson(lay.StateFile);
            if (d == null) return s;
            s.Node = Util.Str(d, "node");
            s.NodePath = Util.Str(d, "nodePath");
            s.StartupShortcut = Util.Str(d, "startupShortcut") == "True";
            s.StartMenuShortcut = Util.Str(d, "startMenuShortcut") == "True";
            int pid;
            int.TryParse(Util.Str(d, "runnerPid"), out pid);
            s.RunnerPid = pid;
            s.RunnerStart = Util.Str(d, "runnerStart");
            s.CreatedAt = Util.Str(d, "createdAt");
            s.EnrollSha = Util.Str(d, "enrollSha");
            return s;
        }

        public void Save(Layout lay)
        {
            Directory.CreateDirectory(lay.Root);
            if (CreatedAt.Length == 0) CreatedAt = DateTime.UtcNow.ToString("o");
            StringBuilder sb = new StringBuilder();
            sb.Append("{\r\n");
            sb.Append("  \"format\": 1,\r\n");
            sb.Append("  \"createdAt\": " + Util.Json(CreatedAt) + ",\r\n");
            sb.Append("  \"node\": " + Util.Json(Node) + ",\r\n");
            sb.Append("  \"nodePath\": " + Util.Json(NodePath) + ",\r\n");
            sb.Append("  \"startupShortcut\": " + (StartupShortcut ? "true" : "false") + ",\r\n");
            sb.Append("  \"startMenuShortcut\": " + (StartMenuShortcut ? "true" : "false") + ",\r\n");
            sb.Append("  \"runnerPid\": " + RunnerPid + ",\r\n");
            sb.Append("  \"runnerStart\": " + Util.Json(RunnerStart) + ",\r\n");
            sb.Append("  \"enrollSha\": " + Util.Json(EnrollSha) + "\r\n");
            sb.Append("}\r\n");
            string tmp = lay.StateFile + ".tmp";
            File.WriteAllText(tmp, sb.ToString(), Util.Utf8);
            if (File.Exists(lay.StateFile)) File.Delete(lay.StateFile);
            File.Move(tmp, lay.StateFile);
        }
    }

    sealed class CheckResult
    {
        public bool NeedsDownload;
        public bool CannotContinue;
        public string Problem = "";
    }

    sealed class Controller
    {
        public readonly Options O;
        public readonly Layout L;
        public readonly IReport R;
        public readonly Cancel C;
        public readonly FileLog Log;
        public readonly List<StepRow> Rows = new List<StepRow>();
        public string SourceDir;        // the unzipped kit folder this program was started from (null when started from the install folder)
        public NodeInfo Node;
        public string PlatformUrl = "", RunnerName = "";
        public InstallState State;
        public string ExePath;

        public Controller(Options o, Layout l, IReport r, Cancel c, FileLog log)
        {
            O = o; L = l; R = r; C = c; Log = log;
            ExePath = Assembly.GetExecutingAssembly().Location;
            Rows.Add(new StepRow("node", "Node.js " + Product.NodeMin + " or newer"));
            Rows.Add(new StepRow("files", "Runner files"));
            Rows.Add(new StepRow("tools", "Test tools (npm packages)"));
            Rows.Add(new StepRow("browser", "Browser for web tests"));
            Rows.Add(new StepRow("extras", "Optional extras"));
            Rows.Add(new StepRow("connection", "Connection to the platform"));
            State = InstallState.Load(L);
            // --all-browsers is still accepted (older shortcuts carry it) and means nothing now: the runner fetches Firefox and WebKit when a run needs them.
        }

        /// <summary>The browser row is information only: the runner itself picks installed Chrome or Edge, or downloads Chromium once.</summary>
        const string BrowserText = "Left to the runner: it uses Google Chrome or Microsoft Edge from this computer, or downloads Chromium once when it first starts";

        // ── a complete download: its own Node.js (node\node.exe) and every test tool (node_modules, marked .aitp-complete) ──

        string KitMarker() { return SourceDir == null ? null : Path.Combine(SourceDir, "node_modules", ".aitp-complete"); }
        string AppMarker() { return Path.Combine(L.App, "node_modules", ".aitp-complete"); }
        bool KitHasTools() { string m = KitMarker(); return m != null && File.Exists(m) && File.Exists(Path.Combine(SourceDir, "node_modules", "@playwright", "test", "package.json")); }

        /// <summary>The Node.js that came with the unzipped complete download, when it starts here and is new enough.</summary>
        NodeInfo KitNode()
        {
            if (SourceDir == null) return null;
            NodeInfo n = NodeFinder.Probe(Path.Combine(SourceDir, "node", "node.exe"));
            return n != null && n.Major >= Product.NodeMin ? n : null;
        }

        /// <summary>The copy of a complete download's Node.js made by an earlier run (installer.json says "bundled").</summary>
        NodeInfo InstalledBundledNode()
        {
            if (State.Node != "bundled") return null;
            NodeInfo n = NodeFinder.Probe(Path.Combine(L.NodeDir, "node.exe"));
            if (n == null || n.Major < Product.NodeMin) return null;
            n.Private = true;
            return n;
        }

        public StepRow Row(string id) { foreach (StepRow r in Rows) if (r.Id == id) return r; return null; }

        void Set(string id, S state, string detail, int percent)
        {
            StepRow r = Row(id);
            r.State = state;
            r.Detail = detail;
            r.Percent = percent;
            R.Row(r.Copy());
        }
        void Set(string id, S state, string detail) { Set(id, state, detail, -1); }

        void Say(string line) { Log.Line(line); }

        // ── where the runner files come from ────────────────────────────────

        public void DetectSource()
        {
            // A one-file download unpacked its kit (Stamp); otherwise the kit is the folder this program was started from.
            string exeDir = Stamp.Dir ?? Path.GetDirectoryName(ExePath);
            bool credential = File.Exists(Path.Combine(exeDir, "runner.enroll")) || File.Exists(Path.Combine(exeDir, "runner.token"));
            bool kit = File.Exists(Path.Combine(exeDir, "runner.mjs")) && File.Exists(Path.Combine(exeDir, "runner.json")) && credential && !Util.SamePath(exeDir, L.App);
            SourceDir = kit ? exeDir : null;
            string cfg = Path.Combine(SourceDir ?? L.App, "runner.json");
            Dictionary<string, object> d = File.Exists(cfg) ? Util.ReadJson(cfg) : null;
            PlatformUrl = Util.Str(d, "url");
            RunnerName = Util.Str(d, "name");
        }

        string AppOrSource(string name)
        {
            string a = Path.Combine(L.App, name);
            if (File.Exists(a)) return a;
            return SourceDir == null ? a : Path.Combine(SourceDir, name);
        }

        // ── Check: look only, change nothing ────────────────────────────────

        public CheckResult Check()
        {
            CheckResult res = new CheckResult();
            DetectSource();
            State = InstallState.Load(L);

            // 1. Node.js (a complete download's own copy first)
            Set("node", S.Checking, "Looking for Node.js on this computer");
            NodeInfo kitNode = KitNode(), bundled = kitNode == null ? InstalledBundledNode() : null;
            NodeSearch s = kitNode != null || bundled != null ? null : NodeFinder.Find(L);
            if (kitNode != null)
            {
                Node = kitNode;
                bool copied = Util.SameFile(kitNode.Path, Path.Combine(L.NodeDir, "node.exe"));
                Row("node").FromKit = true;
                if (copied)
                {
                    // Start the runner with the installed copy, never from the unzipped folder (it may be deleted once the runner is online).
                    NodeInfo inst = NodeFinder.Probe(Path.Combine(L.NodeDir, "node.exe"));
                    if (inst != null) { inst.Private = true; Node = inst; }
                    Set("node", S.Found, "Node.js " + kitNode.Version + " came with this download and is already copied");
                }
                else Set("node", S.Missing, "Node.js " + kitNode.Version + " came with this download and will be copied (no download)");
                Say("Using the Node.js that came with this download, version " + kitNode.Version + ".");
            }
            else if (bundled != null)
            {
                Node = bundled;
                Set("node", S.Found, "Node.js " + bundled.Version + " that came with the download, using it");
                Say("Using the Node.js that came with the download, version " + bundled.Version + ", from " + bundled.Path + ".");
            }
            else if (s.Found != null)
            {
                Node = s.Found;
                Set("node", S.Found, "Node.js " + s.Found.Version + " found, using it");
                Say("Using Node.js " + s.Found.Version + " from " + s.Found.Path + ".");
            }
            else
            {
                Node = null;
                foreach (NodeInfo old in s.TooOld) Say("Found Node.js " + old.Version + " at " + old.Path + ". That is too old, the runner needs " + Product.NodeMin + " or newer.");
                if (s.TooOld.Count > 0) Set("node", S.Missing, "Node.js " + s.TooOld[0].Version + " is too old. A private Node.js " + Product.NodeMin + " will be downloaded");
                else Set("node", S.Missing, "Node.js was not found. A private Node.js " + Product.NodeMin + " will be downloaded");
                if (s.TooOld.Count == 0) Say("Node.js was not found on this computer. " + s.Looked);
                res.NeedsDownload = true;
            }

            // 2. Runner files
            Set("files", S.Checking, "Comparing the runner files");
            if (SourceDir == null)
            {
                // An installed runner keeps its credential protected for this user (or, from an older download, in runner.token).
                if (File.Exists(Path.Combine(L.App, "runner.mjs")) && File.Exists(Path.Combine(L.App, "runner.json")))
                    Set("files", S.Found, "Installed in " + L.App);
                else
                {
                    Set("files", S.Failed, "The runner files are not next to this program");
                    res.CannotContinue = true;
                    res.Problem = "I cannot find the runner files. Open AITestingRunnerSetup.exe from the folder you unzipped: that folder also holds runner.mjs, runner.json and runner.enroll.";
                }
            }
            else
            {
                List<string> missing = new List<string>();
                foreach (string name in Product.BundleFiles) if (!File.Exists(Path.Combine(SourceDir, name)) && name != "LICENSES.txt") missing.Add(name);
                if (missing.Count > 0)
                {
                    Set("files", S.Failed, "Missing from the unzipped folder: " + string.Join(", ", missing.ToArray()));
                    res.CannotContinue = true;
                    res.Problem = "The unzipped folder is incomplete (" + string.Join(", ", missing.ToArray()) + " is missing). Download the runner again from the platform and unzip all of it.";
                }
                else
                {
                    int differ = 0;
                    foreach (string name in AllFiles()) if (WillCopy(name)) differ++;
                    if (differ == 0) Set("files", S.Found, "Already copied to " + L.App);
                    else Set("files", S.Missing, differ + (differ == 1 ? " file" : " files") + " will be copied to " + L.App);
                }
            }

            // 3. Test tools (a complete download has them: they are copied, never downloaded)
            Set("tools", S.Checking, "Checking the installed packages");
            List<string> problems = ToolsProblems();
            if (KitHasTools())
            {
                Row("tools").FromKit = true;
                if (problems != null && problems.Count == 0 && Util.SameFile(KitMarker(), AppMarker())) Set("tools", S.Found, "They came with this download and are already copied");
                else Set("tools", S.Missing, "They came with this download and will be copied (no download)");
            }
            else if (problems == null) { Set("tools", S.Missing, "Will be downloaded with npm after the runner files are copied"); res.NeedsDownload = true; }
            else if (problems.Count == 0) Set("tools", S.Found, "Every package is installed at the version the runner needs");
            else { Set("tools", S.Missing, problems[0] + (problems.Count > 1 ? " (and " + (problems.Count - 1) + " more)" : "") + ". Will be downloaded with npm"); res.NeedsDownload = true; }

            // 4. Browser: nothing to download here any more (the runner chooses one when it starts)
            Set("browser", S.Checked, BrowserText);

            // 5. Extras (reported, never installed on their own)
            Set("extras", S.Checking, "Looking at the optional extras");
            Set("extras", S.Checked, ExtrasText());

            // 6. Connection
            Set("connection", S.Checking, "Checking that the platform can be reached");
            string why;
            if (PlatformUrl.Length == 0) Set("connection", S.Failed, "There is no platform address in runner.json");
            else if (CanReach(PlatformUrl, out why)) Set("connection", S.Found, why);
            else Set("connection", S.Failed, why);
            return res;
        }

        static IEnumerable<string> AllFilesList()
        {
            List<string> all = new List<string>(Product.BundleFiles);
            all.AddRange(Product.KitFiles);
            all.AddRange(Product.OptionalFiles);
            // Only in a complete download: what it holds (the Node.js version, the packages). Copied when it is there.
            all.Add("complete-kit.json");
            return all;
        }
        IEnumerable<string> AllFiles() { return AllFilesList(); }

        /// <summary>Is this file of the download copied: present, different, and not a one-time code that was copied before (or a token beside a code).</summary>
        bool WillCopy(string name)
        {
            string src = Path.Combine(SourceDir, name);
            if (!File.Exists(src) || Util.SameFile(src, Path.Combine(L.App, name))) return false;
            if (name == "runner.enroll" && Util.Sha256File(src) == State.EnrollSha) return false;
            if (name == "runner.token" && File.Exists(Path.Combine(SourceDir, "runner.enroll"))) return false;
            return true;
        }

        // ── Install: do what is missing ─────────────────────────────────────

        /// <summary>Returns null when the runner can be started, or a plain sentence saying why not.</summary>
        public string Install()
        {
            try
            {
                Directory.CreateDirectory(L.Root);
                State = InstallState.Load(L);
                DetectSource();

                // 1. Node.js (a complete download's own copy first: copied into the private folder, never downloaded)
                C.ThrowIfRequested();
                Set("node", S.Checking, "Looking for Node.js on this computer");
                NodeInfo kitNode = KitNode(), bundled = kitNode == null ? InstalledBundledNode() : null;
                NodeSearch s = kitNode != null || bundled != null ? null : NodeFinder.Find(L);
                if (kitNode != null) CopyKitNode(kitNode);
                else if (bundled != null)
                {
                    Node = bundled;
                    Set("node", S.Found, "Node.js " + bundled.Version + " that came with the download, using it");
                    Say("Using the Node.js that came with the download, version " + bundled.Version + ", from " + bundled.Path + ".");
                }
                else if (s.Found != null)
                {
                    Node = s.Found;
                    Set("node", S.Found, "Node.js " + s.Found.Version + " found, using it");
                    Say("Using Node.js " + s.Found.Version + " from " + s.Found.Path + ".");
                    if (State.Node.Length == 0) { State.Node = s.Found.Private ? "private" : "found"; State.NodePath = s.Found.Path; }
                }
                else
                {
                    foreach (NodeInfo old in s.TooOld) Say("Found Node.js " + old.Version + " at " + old.Path + ". That is too old, the runner needs " + Product.NodeMin + " or newer.");
                    DownloadNode();
                }
                State.Save(L);

                // 2. Runner files
                C.ThrowIfRequested();
                CopyRunnerFiles();

                // 3. Test tools
                C.ThrowIfRequested();
                if (KitHasTools()) CopyKitTools();
                else InstallTools();

                // 4. Browser: the runner chooses one itself when it starts
                Set("browser", S.Checked, BrowserText);

                // 5. Extras
                Set("extras", S.Checked, ExtrasText());

                // 6. Connection (a failure here does not stop the runner: it keeps trying)
                Set("connection", S.Checking, "Checking that the platform can be reached");
                string why;
                if (PlatformUrl.Length == 0) Set("connection", S.Failed, "There is no platform address in runner.json");
                else if (CanReach(PlatformUrl, out why)) Set("connection", S.Done, why);
                else Set("connection", S.Failed, why);

                // 7. The runner's own "Check this computer" (docs/features/runner-check.md): its lines in the details and the log
                RunComputerCheck();
                // Done with a one-file download's unpacked kit (and its copy of the one-time code).
                Stamp.Cleanup();
                return null;
            }
            catch (OperationCanceledException)
            {
                return "Cancelled. Nothing is half installed that the next run cannot pick up again.";
            }
            catch (PlainException e)
            {
                Say(e.Message);
                return e.Message;
            }
            catch (UnauthorizedAccessException e)
            {
                string m = "Windows would not let me write to " + L.Root + " (" + e.Message + "). Choose another folder with --install-dir, or check that the folder is yours.";
                Say(m);
                return m;
            }
            catch (IOException e)
            {
                string m = "A file operation failed: " + e.Message + " Close anything that is using the runner folder and try again.";
                Say(m);
                return m;
            }
        }

        // ---- Node.js

        void DownloadNode()
        {
            Set("node", S.Downloading, "Looking up the newest Node.js " + Product.NodeMin + " long-term release");
            Net.NodeRelease rel = Net.ResolveNode(C, Say);
            Say("Node.js " + rel.Version + " will be downloaded from " + Net.DistBase() + ".");
            string shas = Net.GetString(rel.ShasUrl, 30000, C);
            string expected = Net.ExpectedHash(shas, rel.ZipName);
            if (expected == null) throw new PlainException("The list of checksums on " + Util.Hostname(rel.ShasUrl) + " does not mention " + rel.ZipName + ", so I cannot check the download and did not fetch it.");
            Directory.CreateDirectory(L.Downloads);
            string part = Path.Combine(L.Downloads, rel.ZipName + ".part");
            int last = -1;
            Net.DownloadFile(rel.ZipUrl, part, delegate(long got, long total)
            {
                int pct = total > 0 ? (int)(got * 100 / total) : -1;
                if (pct != last)
                {
                    last = pct;
                    Set("node", S.Downloading, "Node.js " + rel.Version + (total > 0 ? " (" + (total / (1024 * 1024)) + " MB)" : ""), pct);
                }
            }, C);
            Set("node", S.Installing, "Checking the download against its published checksum");
            string actual = Util.Sha256File(part);
            if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
            {
                try { File.Delete(part); } catch (Exception) { }
                throw new PlainException("The Node.js download does not match the checksum " + Util.Hostname(rel.ShasUrl) + " publishes for it, so I did not use it and deleted it. Try again; if it keeps happening, a proxy may be changing the download.");
            }
            Set("node", S.Installing, "Unpacking Node.js " + rel.Version + " into " + L.NodeDir);
            string tmp = L.NodeDir + ".new";
            Util.DeleteTree(tmp);
            try
            {
                Net.ExtractDroppingTopFolder(part, tmp, C);
                Util.DeleteTree(L.NodeDir);
                Directory.Move(tmp, L.NodeDir);
            }
            finally { Util.DeleteTreeQuietly(tmp); }
            try { File.Delete(part); } catch (Exception) { }
            NodeInfo n = NodeFinder.Probe(Path.Combine(L.NodeDir, "node.exe"));
            if (n == null || n.Major < Product.NodeMin) throw new PlainException("The Node.js I unpacked does not start on this computer. Antivirus software may have blocked it: check " + L.NodeDir + " and try again.");
            n.Private = true;
            Node = n;
            State.Node = "private";
            State.NodePath = n.Path;
            Set("node", S.Done, "Node.js " + n.Version + " downloaded and checked");
            Say("Node.js " + n.Version + " is now in " + L.NodeDir + ".");
        }

        /// <summary>A complete download's Node.js goes into the private folder (so the unzipped folder can be deleted), and is marked "bundled".</summary>
        void CopyKitNode(NodeInfo kit)
        {
            string dest = Path.Combine(L.NodeDir, "node.exe");
            Row("node").FromKit = true;
            if (!Util.SameFile(kit.Path, dest))
            {
                Set("node", S.Installing, "Copying the Node.js " + kit.Version + " that came with this download");
                string tmp = L.NodeDir + ".new";
                Util.DeleteTree(tmp);
                try
                {
                    Util.CopyTree(Path.Combine(SourceDir, "node"), tmp, C);
                    Util.DeleteTree(L.NodeDir);
                    Directory.Move(tmp, L.NodeDir);
                }
                finally { Util.DeleteTreeQuietly(tmp); }
            }
            NodeInfo n = NodeFinder.Probe(dest);
            if (n == null || n.Major < Product.NodeMin) throw new PlainException("The Node.js that came with this download does not start from " + L.NodeDir + ". Antivirus software may have blocked it: check that folder and try again.");
            n.Private = true;
            Node = n;
            State.Node = "bundled";
            State.NodePath = n.Path;
            Set("node", S.Done, "Node.js " + n.Version + " came with this download (nothing downloaded)");
            Say("Using the Node.js that came with this download, version " + n.Version + ", copied to " + L.NodeDir + ".");
        }

        /// <summary>A complete download's node_modules replaces the installed one when its marker differs; npm is never run for it.</summary>
        void CopyKitTools()
        {
            string modules = Path.Combine(L.App, "node_modules");
            List<string> problems = ToolsProblems();
            Row("tools").FromKit = true;
            if (problems != null && problems.Count == 0 && Util.SameFile(KitMarker(), AppMarker()))
            {
                Set("tools", S.Found, "They came with this download and are already copied");
                return;
            }
            Set("tools", S.Installing, "Copying the test tools that came with this download");
            string tmp = modules + ".new";
            Util.DeleteTree(tmp);
            int n;
            try
            {
                n = Util.CopyTree(Path.Combine(SourceDir, "node_modules"), tmp, C);
                Util.DeleteTree(modules);
                Directory.Move(tmp, modules);
            }
            finally { Util.DeleteTreeQuietly(tmp); }
            List<string> after = ToolsProblems();
            if (after == null || after.Count > 0) throw new PlainException("The test tools that came with this download are not complete" + (after != null && after.Count > 0 ? " (" + after[0] + ")" : "") + ". Unzip the whole download again and run me from that folder.");
            Set("tools", S.Done, "They came with this download (" + n + " files copied, nothing downloaded)");
            Say("Copied the test tools that came with this download into " + modules + ".");
        }

        // ---- files

        void CopyRunnerFiles()
        {
            if (SourceDir == null)
            {
                Set("files", S.Found, "Installed in " + L.App);
                return;
            }
            Directory.CreateDirectory(L.App);
            int copied = 0;
            int toCopy = 0;
            foreach (string name in AllFiles()) if (WillCopy(name)) toCopy++;
            if (toCopy > 0) Set("files", S.Installing, "Copying the runner files");
            foreach (string name in AllFiles())
            {
                string src = Path.Combine(SourceDir, name), dst = Path.Combine(L.App, name);
                if (!File.Exists(src))
                {
                    if (name == "LICENSES.txt" || name == "complete-kit.json" || Array.IndexOf(Product.OptionalFiles, name) >= 0) continue;
                    throw new PlainException("The unzipped folder is incomplete (" + name + " is missing). Download the runner again from the platform.");
                }
                if (Util.SameFile(src, dst)) continue;
                if (name == "runner.enroll")
                {
                    // A one-time code is copied once: the runner deletes its copy after trading it, and the same code is never copied again
                    // (opening this program again from the same unzipped folder must not undo a working setup).
                    string sha = Util.Sha256File(src);
                    if (sha == State.EnrollSha) continue;
                    State.EnrollSha = sha;
                    State.Save(L);
                    // The new code replaces the credential of an older download: the runner prefers a saved credential to a code, so it forgets
                    // its saved one first (round 50; an older runner was stopped before Install). This also removes the old runner.enroll and
                    // runner.token; the new code is copied just below.
                    Say(ForgetCredential());
                }
                if (name == "runner.token" && File.Exists(Path.Combine(SourceDir, "runner.enroll"))) continue;
                File.Copy(src, dst, true);
                if (name == "runner.enroll" || name == "runner.token") RestrictToCurrentUser(dst);
                copied++;
            }
            // This program copies itself next to the runner, so it can start the runner again after the unzipped folder is deleted.
            // Only the program part: a one-file download's appended kit (with its one-time code) is left out.
            try
            {
                if (!Util.SamePath(ExePath, L.SelfCopy))
                {
                    byte[] me = Stamp.ProgramBytes(ExePath);
                    if (!File.Exists(L.SelfCopy) || Util.Sha256File(L.SelfCopy) != Util.Sha256Bytes(me)) File.WriteAllBytes(L.SelfCopy, me);
                }
            }
            catch (IOException) { Say("I could not update my own copy in " + L.Root + " (it may be running). It will be updated the next time."); }
            Set("files", copied == 0 ? S.Found : S.Done, copied == 0 ? "Already copied to " + L.App : copied + (copied == 1 ? " file" : " files") + " copied to " + L.App);
        }

        /// <summary>Only the current user may read the token file.</summary>
        public static void RestrictToCurrentUser(string file)
        {
            FileInfo fi = new FileInfo(file);
            FileSecurity fs = new FileSecurity();
            fs.SetAccessRuleProtection(true, false);
            fs.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.FullControl, AccessControlType.Allow));
            fi.SetAccessControl(fs);
        }

        // ---- test tools

        /// <summary>Why the installed packages are not what the runner needs. Null when package.json cannot be read yet; an empty list when all is well.</summary>
        List<string> ToolsProblems()
        {
            string pkg = AppOrSource("package.json");
            if (!File.Exists(pkg)) return null;
            Dictionary<string, object> d = Util.ReadJson(pkg);
            if (d == null) return null;
            List<string> problems = new List<string>();
            string modules = Path.Combine(L.App, "node_modules");
            object deps;
            if (d.TryGetValue("dependencies", out deps) && deps is IDictionary)
            {
                foreach (DictionaryEntry kv in (IDictionary)deps)
                {
                    string name = Convert.ToString(kv.Key), want = Convert.ToString(kv.Value);
                    string have = InstalledVersion(modules, name);
                    if (have == null) problems.Add(name + " is not installed");
                    else if (have != want) problems.Add(name + " is " + have + " and the runner needs " + want);
                }
            }
            object over;
            if (d.TryGetValue("overrides", out over) && over is IDictionary && ((IDictionary)over).Contains("playwright-core"))
            {
                // One copy only: a second playwright-core would look for browsers of a different version.
                foreach (string nested in new string[] { @"playwright\node_modules\playwright-core", @"@playwright\test\node_modules\playwright-core", @"@axe-core\playwright\node_modules\playwright-core" })
                    if (Directory.Exists(Path.Combine(modules, nested))) problems.Add("a second copy of playwright-core is installed");
            }
            return problems;
        }

        static string InstalledVersion(string modules, string name)
        {
            string f = Path.Combine(modules, name.Replace('/', '\\'), "package.json");
            if (!File.Exists(f)) return null;
            Dictionary<string, object> d = Util.ReadJson(f);
            string v = Util.Str(d, "version");
            return v.Length == 0 ? null : v;
        }

        void InstallTools()
        {
            List<string> problems = ToolsProblems();
            if (problems != null && problems.Count == 0)
            {
                Set("tools", S.Found, "Every package is installed at the version the runner needs");
                return;
            }
            if (Env.On("AITP_INSTALLER_SKIP_NPM"))
            {
                Set("tools", S.Skipped, "Skipped by AITP_INSTALLER_SKIP_NPM");
                Say("Skipping npm install (AITP_INSTALLER_SKIP_NPM is set).");
                return;
            }
            string npm = FindNpmCli();
            if (npm == null) throw new PlainException("I cannot find npm next to " + Node.Path + ". Install the LTS version of Node.js from nodejs.org, or remove this Node.js so I can download my own.");
            Set("tools", S.Installing, "npm is installing the test tools. This needs the internet and can take a few minutes");
            // With the download's lock file: exactly the locked versions and checksums, and no package's install script runs (Playwright
            // needs none). A download from before round 39 has no lock file: npm install, as before.
            bool locked = File.Exists(Path.Combine(L.App, "package-lock.json"));
            string npmArgs = locked ? " ci --ignore-scripts --no-audit --no-fund" : " install --no-audit --no-fund";
            Say("Running npm" + (locked ? " ci" : " install") + " in " + L.App + ".");
            Dictionary<string, string> env = ToolEnv();
            StringBuilder tail = new StringBuilder();
            Queue<string> lastLines = new Queue<string>();
            bool timedOut;
            int code = Util.RunStreaming(Node.Path, Util.Quote(npm) + npmArgs, L.App, env, delegate(string line)
            {
                Say("npm: " + line);
                lock (lastLines) { lastLines.Enqueue(line); if (lastLines.Count > 6) lastLines.Dequeue(); }
            }, 15 * 60 * 1000, C, out timedOut);
            C.ThrowIfRequested();
            if (timedOut) throw new PlainException("npm did not finish within 15 minutes, so I stopped it. Check the internet connection and run me again; what was downloaded is kept.");
            if (code != 0)
            {
                string lastLine;
                lock (lastLines) lastLine = lastLines.Count > 0 ? lastLines.ToArray()[lastLines.Count - 1] : "";
                throw new PlainException("npm could not install the test tools (exit code " + code + ")." + (lastLine.Length > 0 ? " Last message: " + lastLine : "") + " Check the internet connection, then run me again.");
            }
            List<string> after = ToolsProblems();
            if (after != null && after.Count > 0) throw new PlainException("npm finished but the test tools are not as expected: " + after[0] + ". Run me again; if it repeats, delete " + Path.Combine(L.App, "node_modules") + " first.");
            Set("tools", S.Done, "The test tools are installed");
        }

        /// <summary>npm-cli.js of the Node.js in use. Asks Node for its real location first (Volta and similar tools put a small stand-in on the PATH).</summary>
        string FindNpmCli()
        {
            List<string> dirs = new List<string>();
            dirs.Add(Path.GetDirectoryName(Node.Path));
            Util.Captured c = Util.Run(Node.Path, "-p process.execPath", 15000, null, null);
            string real = c.Out.Replace("\r", "").Trim();
            if (c.Code == 0 && real.Length > 0 && File.Exists(real)) dirs.Add(Path.GetDirectoryName(real));
            foreach (string d in dirs)
            {
                string f = Path.Combine(d, "node_modules", "npm", "bin", "npm-cli.js");
                if (File.Exists(f)) return f;
            }
            return null;
        }

        Dictionary<string, string> ToolEnv()
        {
            Dictionary<string, string> env = new Dictionary<string, string>();
            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            env["PATH"] = Path.GetDirectoryName(Node.Path) + ";" + path;
            env["NO_UPDATE_NOTIFIER"] = "1";
            env["NO_COLOR"] = "1";
            env["npm_config_fund"] = "false";
            env["npm_config_audit"] = "false";
            return env;
        }

        // ---- "Check this computer"

        /// <summary>Found in the text of a runner program that knows --check (src/agent/computer-check.ts CHECK_MARKER).</summary>
        const string CheckMarker = "aitp-computer-check/1";

        /// <summary>
        /// Runs the installed runner's own check (node runner.mjs --check, the same as check-computer.cmd) and shows each line. Only a runner
        /// program that knows the check is asked, so an older one is never started by accident. It changes nothing, never prints the token,
        /// and never fails the setup.
        /// </summary>
        void RunComputerCheck()
        {
            try
            {
                string runner = Path.Combine(L.App, "runner.mjs");
                if (Node == null || !File.Exists(runner) || !File.ReadAllText(runner).Contains(CheckMarker)) return;
                Say("Checking this computer (the same check as check-computer.cmd):");
                Util.Captured c = Util.Run(Node.Path, Util.Quote(runner) + " --check", 90000, L.App, ToolEnv());
                foreach (string l in c.Out.Replace("\r", "").Split('\n')) if (l.Trim().Length > 0) Say("  " + l.TrimEnd());
                if (c.TimedOut) Say("The check did not finish within 90 seconds, so I stopped it.");
            }
            catch (Exception e)
            {
                Say("The check of this computer could not run: " + e.Message);
            }
        }

        // ---- extras and connection

        string ExtrasText()
        {
            string adb = FindAdb();
            // Phone tools: the runner fetches Google's platform-tools (adb) into its own folder when a phone session needs them (docs/features/phone-setup-simple.md).
            string android = adb != null ? "Android tools found" : "Android tools not found: the runner gets Google's phone tools (adb, about 10 MB) itself when a phone session needs them";
            return android + "; Windows desktop apps off; Firefox and WebKit are fetched by the runner only when a run needs them";
        }

        static string FindAdb()
        {
            List<string> dirs = new List<string>();
            foreach (string d in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries)) dirs.Add(d.Trim('"'));
            foreach (string v in new string[] { "ANDROID_HOME", "ANDROID_SDK_ROOT" })
            {
                string h = Environment.GetEnvironmentVariable(v);
                if (!string.IsNullOrEmpty(h)) dirs.Add(Path.Combine(h, "platform-tools"));
            }
            string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
            if (!string.IsNullOrEmpty(local)) dirs.Add(Path.Combine(local, "Android", "Sdk", "platform-tools"));
            foreach (string d in dirs)
            {
                try { if (File.Exists(Path.Combine(d, "adb.exe"))) return Path.Combine(d, "adb.exe"); } catch (Exception) { }
            }
            return null;
        }

        /// <summary>A plain GET of the platform's open health route. Says what the person can do when it fails.</summary>
        public static bool CanReach(string baseUrl, out string message)
        {
            string host = Util.Hostname(baseUrl);
            try
            {
                Uri u = new Uri(baseUrl.TrimEnd('/') + "/api/health");
                if (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps) { message = "The platform address " + baseUrl + " is not an http or https address."; return false; }
                HttpWebRequest rq = (HttpWebRequest)WebRequest.Create(u);
                rq.Timeout = 8000;
                rq.UserAgent = "AITestingRunnerSetup/1";
                using (HttpWebResponse resp = (HttpWebResponse)rq.GetResponse())
                {
                    message = "Reached " + host;
                    return true;
                }
            }
            catch (WebException e)
            {
                HttpWebResponse r = e.Response as HttpWebResponse;
                if (r != null)
                {
                    // The server answered, so it can be reached: the health route may simply be protected.
                    message = "Reached " + host + " (it answered " + (int)r.StatusCode + ")";
                    return true;
                }
                message = "Cannot reach " + baseUrl + " (" + e.Message + "). Likely reasons: this computer is offline, a firewall or proxy blocks it, the address is wrong, or the platform is switched off. On a company network a proxy may be the reason: the runner uses the Windows proxy setting or HTTPS_PROXY, and you can add \"proxy\" (and \"caFile\" for a company certificate) to runner.json; see docs/features/company-networks.md.";
                return false;
            }
            catch (Exception e)
            {
                message = "Cannot reach " + baseUrl + " (" + e.Message + "). Check the address in runner.json.";
                return false;
            }
        }

        // ── shortcuts ───────────────────────────────────────────────────────

        public void MakeShortcut(string linkPath, string args, string description)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(linkPath));
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            if (t == null) throw new PlainException("Windows does not offer shortcut creation here.");
            object shell = Activator.CreateInstance(t);
            object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { linkPath });
            Type lt = lnk.GetType();
            string target = File.Exists(L.SelfCopy) ? L.SelfCopy : ExePath;
            lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
            lt.InvokeMember("Arguments", BindingFlags.SetProperty, null, lnk, new object[] { args });
            lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { Path.GetDirectoryName(target) });
            lt.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { description });
            lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
        }

        public static string ShortcutTarget(string linkPath)
        {
            try
            {
                if (!File.Exists(linkPath)) return null;
                Type t = Type.GetTypeFromProgID("WScript.Shell");
                object shell = Activator.CreateInstance(t);
                object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { linkPath });
                return Convert.ToString(lnk.GetType().InvokeMember("TargetPath", BindingFlags.GetProperty, null, lnk, null));
            }
            catch (Exception) { return null; }
        }

        public void ApplyShortcuts(bool startAtSignIn, bool startMenu)
        {
            State = InstallState.Load(L);
            string target = File.Exists(L.SelfCopy) ? L.SelfCopy : ExePath;
            string common = "--install-dir " + Util.Quote(L.Root);
            // Only the Startup shortcut starts quietly; the Start menu one opens the window.
            if (startAtSignIn) { MakeShortcut(L.StartupLink(), "--background " + common, "Starts the AI Testing Runner when you sign in"); State.StartupShortcut = true; Say("Added a shortcut to the Startup folder: " + L.StartupLink()); }
            else if (State.StartupShortcut) { RemoveOwnShortcut(L.StartupLink()); State.StartupShortcut = false; Say("Removed the Startup shortcut."); }
            if (startMenu) { MakeShortcut(L.StartMenuLink(), common, "Opens the AI Testing Runner"); State.StartMenuShortcut = true; Say("Added a Start menu shortcut: " + L.StartMenuLink()); }
            else if (State.StartMenuShortcut) { RemoveOwnShortcut(L.StartMenuLink()); State.StartMenuShortcut = false; }
            State.Save(L);
        }

        /// <summary>Deletes a shortcut only if it points at this installation.</summary>
        bool RemoveOwnShortcut(string link)
        {
            string t = ShortcutTarget(link);
            if (t == null || !Util.IsUnder(t, L.Root)) return false;
            try { File.Delete(link); return true; } catch (Exception) { return false; }
        }

        // ── uninstall ───────────────────────────────────────────────────────

        /// <summary>
        /// The runner deletes the credential it keeps protected for this user (it knows where; this program never reads it), before its folder
        /// goes. Then the files that could hold one: a one-time code not yet traded, and an older download's runner.token.
        /// </summary>
        string ForgetCredential()
        {
            string node = State.NodePath.Length > 0 && File.Exists(State.NodePath) ? State.NodePath : Path.Combine(L.NodeDir, "node.exe");
            string said = "The runner's saved access was not found (it never connected, or an older runner kept it in runner.token).";
            if (File.Exists(node) && File.Exists(Path.Combine(L.App, "runner.mjs")))
            {
                Util.Captured c = Util.Run(node, "runner.mjs --forget-credential", 30000, L.App, null);
                if (c.Code == 0) said = "Removed the runner's saved access from this computer.";
            }
            foreach (string f in new string[] { "runner.enroll", "runner.token" })
            {
                try { File.Delete(Path.Combine(L.App, f)); } catch (Exception) { }
            }
            return said;
        }

        /// <summary>Removes what this program created. Returns the lines to show. Never touches a Node.js found elsewhere, the shared browser cache, or files it did not make.</summary>
        public List<string> Uninstall(out bool selfRemovalScheduled)
        {
            selfRemovalScheduled = false;
            List<string> removed = new List<string>();
            State = InstallState.Load(L);
            if (!File.Exists(L.StateFile))
            {
                removed.Add("Nothing to remove: " + L.Root + " has no record of an installation by this program.");
                return removed;
            }
            if (RemoveOwnShortcut(L.StartupLink())) removed.Add("Removed the Startup shortcut " + L.StartupLink());
            if (RemoveOwnShortcut(L.StartMenuLink())) removed.Add("Removed the Start menu shortcut " + L.StartMenuLink());
            removed.Add(ForgetCredential());
            string[] folders = { L.App, L.NodeDir, L.Logs, L.Downloads, L.NodeDir + ".new" };
            List<string> stuck = new List<string>();
            foreach (string d in folders)
            {
                if (!Directory.Exists(d)) continue;
                try { Util.DeleteTreeRetrying(d); removed.Add("Removed " + d + (d == L.NodeDir ? " (the private Node.js)" : "")); }
                catch (Exception e) { removed.Add("Could not remove " + d + ": " + e.Message); stuck.Add(d); }
            }
            bool selfInside = Util.IsUnder(ExePath, L.Root);
            if (File.Exists(L.SelfCopy) && !Util.SamePath(ExePath, L.SelfCopy))
            {
                try { File.Delete(L.SelfCopy); removed.Add("Removed " + L.SelfCopy); } catch (Exception e) { removed.Add("Could not remove " + L.SelfCopy + ": " + e.Message); }
            }
            try { File.Delete(L.StateFile); } catch (Exception) { }
            // The folder itself goes only when nothing else is in it. A running copy of this program cannot delete itself, so a small helper does it afterwards
            // (cmd's rmdir without /s: it removes the folder only when it is empty, and never follows a link).
            if (selfInside)
            {
                string cmd = "/c ping -n 4 127.0.0.1 >nul & del /f /q " + Util.Quote(ExePath) + " & rmdir " + Util.Quote(L.Root);
                try
                {
                    System.Diagnostics.ProcessStartInfo psi = new System.Diagnostics.ProcessStartInfo(Util.SystemTool("cmd.exe"), cmd);
                    psi.CreateNoWindow = true;
                    psi.UseShellExecute = false;
                    // Not inside the folder it is about to remove: a folder that is some process's current folder cannot be deleted.
                    psi.WorkingDirectory = Path.GetTempPath();
                    System.Diagnostics.Process.Start(psi);
                    selfRemovalScheduled = true;
                    removed.Add(stuck.Count == 0 ? "This program will remove itself and " + L.Root + " in a few seconds." : "This program will remove itself in a few seconds. " + L.Root + " stays until the folders above are deleted.");
                }
                catch (Exception) { removed.Add("Delete " + L.Root + " by hand to finish."); }
            }
            else if (stuck.Count == 0)
            {
                // The install folder goes when nothing else is in it, tried again for a few seconds for the same reason as DeleteTreeRetrying.
                for (int i = 0; i < 16 && Directory.Exists(L.Root); i++)
                {
                    // An entry still listed may be one Windows has only marked for deletion: wait a moment and look again before giving up.
                    try { if (Directory.GetFileSystemEntries(L.Root).Length > 0) { System.Threading.Thread.Sleep(400); continue; } Directory.Delete(L.Root); removed.Add("Removed " + L.Root); break; }
                    catch (Exception) { System.Threading.Thread.Sleep(400); }
                }
            }
            // A folder another program still has open is left for the person, with the reason: nothing deletes it later behind their back (a later
            // install into the same folder must never lose its files, and a background delete could follow a link out of the folder).
            if (stuck.Count > 0)
                removed.Add("Another program still has " + (stuck.Count == 1 ? "that folder" : "those folders") + " open (often a File Explorer or terminal window in it). Close it, then delete " + L.Root + " by hand, or delete it after restarting the computer.");
            removed.Add("Left alone: any Node.js that was already on this computer, and the shared browser cache.");
            return removed;
        }
    }
}
