// A stand-in for Windows' reg.exe in the company-network tests (pointed at with AITP_REG_PATH): it answers
// `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"` with the text in FAKE_REG_OUTPUT, written the way
// reg.exe writes it (CRLF line ends). FAKE_REG_EXIT makes it fail instead. It reads nothing from the real registry.
const [cmd, key] = process.argv.slice(2);
if (cmd !== "query" || key !== "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings") {
    process.stderr.write("ERROR: Invalid syntax.\r\n");
    process.exit(1);
}
if (process.env.FAKE_REG_EXIT) {
    process.stderr.write("ERROR: The system was unable to find the specified registry key or value.\r\n");
    process.exit(Number(process.env.FAKE_REG_EXIT));
}
process.stdout.write((process.env.FAKE_REG_OUTPUT ?? "").replace(/\r?\n/g, "\r\n"));
