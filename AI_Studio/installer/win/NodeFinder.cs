// Finding Node.js 24 or newer the way start-runner.cmd does (src/platform/runner-kit-scripts.ts): the same places, the same rule (the first
// candidate whose `--version` answers 24 or newer wins, an older one found first does not stop the search), plus the private copy this
// installer put in its own folder. Only node.exe files are tried; start-runner.cmd also accepts a node.cmd, which the runner could not
// use as its own process anyway.

using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace AITestingRunner
{
    sealed class NodeInfo
    {
        public string Path, Version;
        public int Major;
        public bool Private;
    }

    sealed class NodeSearch
    {
        public NodeInfo Found;
        public List<NodeInfo> TooOld = new List<NodeInfo>();
        public string Looked = "";
    }

    static class NodeFinder
    {
        static readonly Regex VersionRe = new Regex(@"^v(\d+)\.(\d+)\.(\d+)[.0-9A-Za-z-]*$");

        /// <summary>Asks a node.exe for its version. Null when it does not answer with something shaped like v26.1.0.</summary>
        public static NodeInfo Probe(string exe)
        {
            if (!File.Exists(exe)) return null;
            Util.Captured c = Util.Run(exe, "--version", 15000, null, null);
            if (c.Code != 0) return null;
            string line = "";
            foreach (string l in c.Out.Replace("\r", "").Split('\n')) { if (l.Trim().Length > 0) { line = l.Trim(); break; } }
            Match m = VersionRe.Match(line);
            if (!m.Success) return null;
            NodeInfo n = new NodeInfo();
            n.Path = exe;
            n.Version = line;
            n.Major = int.Parse(m.Groups[1].Value);
            return n;
        }

        public static NodeSearch Find(Layout lay)
        {
            NodeSearch result = new NodeSearch();
            List<string> candidates = new List<string>();
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            Action<string> addExe = delegate(string exe)
            {
                if (string.IsNullOrEmpty(exe)) return;
                string full;
                try { full = Path.GetFullPath(exe); } catch (Exception) { return; }
                if (File.Exists(full) && seen.Add(full)) candidates.Add(full);
            };
            Action<string> addDir = delegate(string dir) { if (!string.IsNullOrEmpty(dir)) addExe(Path.Combine(dir.Trim().Trim('"'), "node.exe")); };
            Action<string> addChildren = delegate(string parentWithPattern)
            {
                // "C:\x\v*" style: every sub-folder whose name matches
                try
                {
                    string parent = Path.GetDirectoryName(parentWithPattern);
                    string pattern = Path.GetFileName(parentWithPattern);
                    if (string.IsNullOrEmpty(parent) || !Directory.Exists(parent)) return;
                    foreach (string d in Directory.GetDirectories(parent, pattern)) addDir(d);
                }
                catch (Exception) { }
            };

            string only = Env.Get("AITP_INSTALLER_NODE_SEARCH_ONLY");
            if (only.Length > 0)
            {
                foreach (string d in only.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries)) addDir(d);
                result.Looked = "I looked only in the folders I was told to use.";
            }
            else
            {
                string path = Environment.GetEnvironmentVariable("PATH") ?? "";
                foreach (string d in path.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries)) addDir(d);

                string pf = Environment.GetEnvironmentVariable("ProgramFiles"), pw = Environment.GetEnvironmentVariable("ProgramW6432"), px = Environment.GetEnvironmentVariable("ProgramFiles(x86)");
                string local = Environment.GetEnvironmentVariable("LOCALAPPDATA"), roaming = Environment.GetEnvironmentVariable("APPDATA");
                if (!string.IsNullOrEmpty(pf)) addDir(Path.Combine(pf, "nodejs"));
                if (!string.IsNullOrEmpty(pw)) addDir(Path.Combine(pw, "nodejs"));
                if (!string.IsNullOrEmpty(px)) addDir(Path.Combine(px, "nodejs"));
                if (!string.IsNullOrEmpty(local)) addDir(Path.Combine(local, "Programs", "nodejs"));
                addDir(Environment.GetEnvironmentVariable("NVM_SYMLINK"));
                if (!string.IsNullOrEmpty(local)) addDir(Path.Combine(local, "Volta", "bin"));
                string volta = Environment.GetEnvironmentVariable("VOLTA_HOME");
                if (!string.IsNullOrEmpty(volta)) addDir(Path.Combine(volta, "bin"));
                string nvm = Environment.GetEnvironmentVariable("NVM_HOME");
                if (!string.IsNullOrEmpty(nvm)) addChildren(Path.Combine(nvm, "v*"));
                if (!string.IsNullOrEmpty(roaming)) { addChildren(Path.Combine(roaming, "nvm", "v*")); AddFnm(Path.Combine(roaming, "fnm", "node-versions"), addDir); }
                if (!string.IsNullOrEmpty(local))
                {
                    addChildren(Path.Combine(local, "nvm", "v*"));
                    AddFnm(Path.Combine(local, "fnm", "node-versions"), addDir);
                    addChildren(Path.Combine(local, "fnm_multishells", "*"));
                }
                // The PATH Windows has saved: a window that was opened before Node.js was installed does not have it in its own PATH.
                foreach (string d in SavedPath()) addDir(d);
                result.Looked = "I looked on the PATH, in Program Files, in the nvm-windows, Volta and fnm folders, and in the PATH saved in Windows.";
            }
            // A copy this installer put in its own folder on an earlier run.
            addExe(Path.Combine(lay.NodeDir, "node.exe"));

            foreach (string exe in candidates)
            {
                NodeInfo n = Probe(exe);
                if (n == null) continue;
                n.Private = Util.IsUnder(exe, lay.NodeDir);
                if (n.Major >= Product.NodeMin) { result.Found = n; return result; }
                if (result.TooOld.Count < 3) result.TooOld.Add(n);
            }
            return result;
        }

        static void AddFnm(string versions, Action<string> addDir)
        {
            try
            {
                if (!Directory.Exists(versions)) return;
                foreach (string d in Directory.GetDirectories(versions)) addDir(Path.Combine(d, "installation"));
            }
            catch (Exception) { }
        }

        /// <summary>Directories of the machine and user PATH as saved in the registry (read only), with %VARIABLES% expanded from the saved values.</summary>
        static IEnumerable<string> SavedPath()
        {
            List<string> dirs = new List<string>();
            try
            {
                using (RegistryKey m = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Session Manager\Environment")) AddFrom(m, dirs);
                using (RegistryKey u = Registry.CurrentUser.OpenSubKey("Environment")) AddFrom(u, dirs);
            }
            catch (Exception) { }
            return dirs;
        }

        static void AddFrom(RegistryKey key, List<string> dirs)
        {
            if (key == null) return;
            string raw = key.GetValue("Path", "", RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
            if (string.IsNullOrEmpty(raw)) return;
            foreach (string part in raw.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
            {
                string d = Regex.Replace(part, "%([^%]+)%", delegate(Match m)
                {
                    string name = m.Groups[1].Value;
                    string v = Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.Process);
                    if (string.IsNullOrEmpty(v)) v = Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.User);
                    if (string.IsNullOrEmpty(v)) v = Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.Machine);
                    return string.IsNullOrEmpty(v) ? m.Value : v;
                });
                dirs.Add(d);
            }
        }
    }
}
