// Downloads, checksums and unzipping: everything the installer fetches goes through here.
// https only, except when the test-only AITP_NODE_DIST_URL names another base (a local server standing in for nodejs.org).

using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace AITestingRunner
{
    static class Net
    {
        public static void Init()
        {
            try
            {
                // TLS 1.2 and 1.3 (the numbers, because the older framework builds do not all name them).
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)(3072 | 12288);
            }
            catch (Exception)
            {
                try { ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; } catch (Exception) { }
            }
            ServicePointManager.Expect100Continue = false;
        }

        public static bool DistOverridden { get { return Env.Get("AITP_NODE_DIST_URL").Length > 0; } }

        public static string DistBase()
        {
            string o = Env.Get("AITP_NODE_DIST_URL");
            return (o.Length > 0 ? o : Product.DefaultDist).TrimEnd('/');
        }

        static HttpWebRequest Open(string url, int timeoutMs, bool allowHttp)
        {
            Uri u;
            if (!Uri.TryCreate(url, UriKind.Absolute, out u)) throw new PlainException("The address " + url + " is not valid.");
            if (u.Scheme != Uri.UriSchemeHttps && !(allowHttp && u.Scheme == Uri.UriSchemeHttp))
                throw new PlainException("I only download over https, and " + url + " is not. Nothing was downloaded.");
            HttpWebRequest rq = (HttpWebRequest)WebRequest.Create(u);
            rq.Timeout = timeoutMs;
            rq.ReadWriteTimeout = timeoutMs;
            rq.UserAgent = "AITestingRunnerSetup/1";
            rq.AllowAutoRedirect = true;
            rq.MaximumAutomaticRedirections = 5;
            return rq;
        }

        static void CheckFinalAddress(HttpWebResponse resp, bool allowHttp)
        {
            if (resp.ResponseUri.Scheme != Uri.UriSchemeHttps && !(allowHttp && resp.ResponseUri.Scheme == Uri.UriSchemeHttp))
                throw new PlainException("The server sent me to a plain http address. I only download over https, so I stopped.");
        }

        public static string GetString(string url, int timeoutMs, Cancel cancel)
        {
            bool allowHttp = DistOverridden;
            HttpWebRequest rq = Open(url, timeoutMs, allowHttp);
            try
            {
                using (HttpWebResponse resp = (HttpWebResponse)rq.GetResponse())
                {
                    CheckFinalAddress(resp, allowHttp);
                    using (StreamReader r = new StreamReader(resp.GetResponseStream(), Encoding.UTF8)) return r.ReadToEnd();
                }
            }
            catch (WebException e) { throw Describe(e, url); }
        }

        /// <summary>Downloads to a file. Fails plainly on an interrupted or cut-short transfer; the partial file is deleted.</summary>
        public static void DownloadFile(string url, string dest, Action<long, long> progress, Cancel cancel)
        {
            bool allowHttp = DistOverridden;
            HttpWebRequest rq = Open(url, 60000, allowHttp);
            Directory.CreateDirectory(Path.GetDirectoryName(dest));
            try
            {
                try
                {
                    using (HttpWebResponse resp = (HttpWebResponse)rq.GetResponse())
                    {
                        CheckFinalAddress(resp, allowHttp);
                        long total = resp.ContentLength;
                        long got = 0;
                        byte[] buf = new byte[1 << 16];
                        using (Stream src = resp.GetResponseStream())
                        using (FileStream dst = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None))
                        {
                            int n;
                            while ((n = src.Read(buf, 0, buf.Length)) > 0)
                            {
                                cancel.ThrowIfRequested();
                                dst.Write(buf, 0, n);
                                got += n;
                                if (progress != null) progress(got, total);
                            }
                        }
                        if (total >= 0 && got != total) throw new PlainException("The download was cut short (" + got + " of " + total + " bytes). Check the internet connection and try again.");
                    }
                }
                catch (WebException e) { throw Describe(e, url); }
                catch (IOException e) { throw new PlainException("The download was interrupted (" + e.Message + "). Check the internet connection and try again."); }
            }
            catch (Exception)
            {
                try { File.Delete(dest); } catch (Exception) { }
                throw;
            }
        }

        static PlainException Describe(WebException e, string url)
        {
            HttpWebResponse r = e.Response as HttpWebResponse;
            if (r != null) return new PlainException("The server answered " + (int)r.StatusCode + " " + r.StatusDescription + " for " + url + ".");
            switch (e.Status)
            {
                case WebExceptionStatus.NameResolutionFailure: return new PlainException("I could not find " + Util.Hostname(url) + ". Check that this computer is online.");
                case WebExceptionStatus.ConnectFailure: return new PlainException("I could not connect to " + Util.Hostname(url) + ". Check the internet connection, a firewall or a proxy.");
                case WebExceptionStatus.Timeout: return new PlainException("Waiting for " + Util.Hostname(url) + " took too long. Check the internet connection and try again.");
                case WebExceptionStatus.TrustFailure:
                case WebExceptionStatus.SecureChannelFailure: return new PlainException("The secure connection to " + Util.Hostname(url) + " could not be set up (" + e.Message + "). A proxy or an old Windows may be the cause.");
                case WebExceptionStatus.ConnectionClosed:
                case WebExceptionStatus.ReceiveFailure: return new PlainException("The connection to " + Util.Hostname(url) + " was closed before the download finished. Try again.");
                default: return new PlainException("Could not reach " + Util.Hostname(url) + ": " + e.Message);
            }
        }

        // ── Node.js releases ────────────────────────────────────────────────

        public sealed class NodeRelease
        {
            public string Version, ZipName, ZipUrl, ShasUrl;
            public bool FromIndex;
        }

        /// <summary>The newest long-term-support Node.js of major 24 or newer that has a Windows x64 zip. The pinned version when the index cannot be read.</summary>
        public static NodeRelease ResolveNode(Cancel cancel, Action<string> log)
        {
            string dist = DistBase();
            string version = null;
            bool fromIndex = false;
            try
            {
                string json = GetString(dist + "/index.json", 30000, cancel);
                JavaScriptSerializer js = new JavaScriptSerializer();
                js.MaxJsonLength = int.MaxValue;
                object[] list = js.Deserialize<object[]>(json);
                foreach (object o in list)
                {
                    Dictionary<string, object> e = o as Dictionary<string, object>;
                    if (e == null) continue;
                    object lts;
                    if (!e.TryGetValue("lts", out lts) || !(lts is string) || ((string)lts).Length == 0) continue;
                    string v = Util.Str(e, "version");
                    Match m = Regex.Match(v, @"^v(\d+)\.\d+\.\d+$");
                    if (!m.Success || int.Parse(m.Groups[1].Value) < Product.NodeMin) continue;
                    object files;
                    bool zip = false;
                    if (e.TryGetValue("files", out files) && files is IEnumerable)
                        foreach (object f in (IEnumerable)files) if ("win-x64-zip".Equals(f as string)) zip = true;
                    if (!zip) continue;
                    version = v;
                    fromIndex = true;
                    break;
                }
            }
            catch (PlainException e) { if (log != null) log("Could not read the list of Node.js versions (" + e.Message + "). Using " + Product.PinnedNode + "."); }
            catch (Exception e) { if (log != null) log("Could not read the list of Node.js versions (" + e.Message + "). Using " + Product.PinnedNode + "."); }
            if (version == null) version = Product.PinnedNode;
            NodeRelease r = new NodeRelease();
            r.Version = version;
            r.FromIndex = fromIndex;
            r.ZipName = "node-" + version + "-win-x64.zip";
            r.ZipUrl = dist + "/" + version + "/" + r.ZipName;
            r.ShasUrl = dist + "/" + version + "/SHASUMS256.txt";
            return r;
        }

        /// <summary>The expected SHA-256 of a file name, from the SHASUMS256.txt text ("hash  name" lines).</summary>
        public static string ExpectedHash(string shasums, string fileName)
        {
            foreach (string raw in shasums.Replace("\r", "").Split('\n'))
            {
                Match m = Regex.Match(raw.Trim(), @"^([0-9a-fA-F]{64})\s+\*?(.+)$");
                if (m.Success && m.Groups[2].Value.Trim() == fileName) return m.Groups[1].Value.ToLowerInvariant();
            }
            return null;
        }

        // ── unzip ───────────────────────────────────────────────────────────

        /// <summary>Extracts a zip into a folder, dropping the single top folder it contains (node-v24.x-win-x64\). Refuses paths that climb out of the target.</summary>
        public static void ExtractDroppingTopFolder(string zip, string destDir, Cancel cancel)
        {
            long totalLimit = 1500L * 1024 * 1024;
            long written = 0;
            string root = Path.GetFullPath(destDir).TrimEnd('\\') + "\\";
            Directory.CreateDirectory(destDir);
            using (ZipArchive a = ZipFile.OpenRead(zip))
            {
                foreach (ZipArchiveEntry e in a.Entries)
                {
                    cancel.ThrowIfRequested();
                    string name = e.FullName.Replace('\\', '/');
                    int slash = name.IndexOf('/');
                    if (slash < 0) continue; // a file at the top: not part of a Node.js zip
                    string rel = name.Substring(slash + 1);
                    if (rel.Length == 0) continue;
                    string target = Path.GetFullPath(Path.Combine(destDir, rel.Replace('/', '\\')));
                    if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new PlainException("The downloaded file holds a path that points outside its folder, so I did not unpack it.");
                    if (name.EndsWith("/")) { Directory.CreateDirectory(target); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    written += e.Length;
                    if (written > totalLimit) throw new PlainException("The downloaded file unpacks to more than expected, so I stopped.");
                    e.ExtractToFile(target, true);
                }
            }
        }
    }
}
