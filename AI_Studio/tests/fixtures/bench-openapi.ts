/**
 * The bench apps' own API documents (examples/bench-*\/server.mjs OPENAPI), fetched from a clean app on a free loopback port, so the
 * documented-case tests read what the apps really publish.
 */
import net from "node:net";
import { startBenchApp, type BenchApp } from "../../src/eval/bench/verify/app.js";

const freePort = () =>
    new Promise<number>((resolve) => {
        const s = net.createServer().listen(0, "127.0.0.1", () => {
            const port = (s.address() as net.AddressInfo).port;
            s.close(() => resolve(port));
        });
    });

export async function benchOpenApi(app: BenchApp): Promise<any> {
    const running = await startBenchApp(app, await freePort());
    try {
        return await (await fetch(`${running.base}/openapi.json`)).json();
    } finally {
        await running.stop();
    }
}
