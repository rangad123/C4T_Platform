// Stand-in for `java -jar bundletool.jar build-apks ...`, used by tests/phone-reliability.test.ts through AITP_JAVA_PATH (never a real Java or
// bundletool). It checks the arguments the platform passes and writes an .apks set (a zip) holding universal.apk, like bundletool --mode=universal.
// A bundle whose bytes contain BROKEN-BUNDLE fails the way bundletool does.
import fs from "node:fs";
import { strToU8, zipSync } from "fflate";

const args = process.argv.slice(2);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
if (args[0] !== "-jar" || !/\.jar$/i.test(args[1] ?? "") || args[2] !== "build-apks" || !args.includes("--mode=universal")) {
    process.stderr.write("Error: unexpected arguments\n");
    process.exit(2);
}
const bundle = opt("bundle");
const output = opt("output");
if (!bundle || !output || !fs.existsSync(bundle)) {
    process.stderr.write("Error: the bundle file was not found\n");
    process.exit(1);
}
if (fs.readFileSync(bundle).includes("BROKEN-BUNDLE")) {
    process.stderr.write("[BT:1.15.6] Error: Bundle config 'BundleConfig.pb' could not be parsed.\n");
    process.exit(1);
}
const apk = strToU8("PK\u0003\u0004 fake universal apk AndroidManifest.xml classes.dex");
fs.writeFileSync(output, zipSync({ "toc.pb": strToU8("toc"), "universal.apk": apk }));
