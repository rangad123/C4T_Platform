/**
 * --proxy-tests (a runner on a company network, see src/agent/net.ts): the run's Playwright config gives the browser and the tests'
 * API calls (`request`) Playwright's own `proxy` option, so they reach the application through the proxy too.
 *
 * Off (the default, and always on the platform unless AITP_PROXY_TESTS=1 is set there) the config is exactly what it was, byte for
 * byte. On, the proxy's address and sign-in are read from the environment when Playwright loads the config, never written into the
 * file in the run folder.
 */

const truthy = (v: string | undefined): boolean => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());

/** Source text: the proxy from HTTPS_PROXY / HTTP_PROXY (either case) and NO_PROXY, in Playwright's shape. */
const HELPER = `
// --proxy-tests: the browser and the API calls of the tests reach the application through the proxy. Its address and sign-in are
// read from the environment when the run starts, never written into this file.
const testProxy = (() => {
    const raw = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
    if (!raw) return undefined;
    const u = new URL(/^[a-z][a-z0-9+.-]*:\\/\\//i.test(raw) ? raw : "http://" + raw);
    const bypass = process.env.no_proxy || process.env.NO_PROXY;
    return { server: u.protocol + "//" + u.host, ...(bypass ? { bypass } : {}), ...(u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : {}) };
})();
`;

/** The config with the proxy added when the environment asks for it (AITP_PROXY_TESTS=1 and a proxy is set); otherwise unchanged. */
export function withTestProxy(config: string, env: NodeJS.ProcessEnv): string {
    if (!truthy(env.AITP_PROXY_TESTS)) return config;
    if (!(env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY)) return config;
    const firstLineEnd = config.indexOf("\n");
    if (firstLineEnd < 0 || !config.includes("    use: {")) return config;
    const withHelper = `${config.slice(0, firstLineEnd + 1)}${HELPER}${config.slice(firstLineEnd + 1)}`;
    return withHelper.replace("    use: {", () => "    use: {\n        ...(testProxy ? { proxy: testProxy } : {}),");
}
