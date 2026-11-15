// Which host names are an application's own, by one strict rule for the API checks (src/engine/identity/access.ts) and the selection
// preview (src/platform/selection/coverage.ts). Nothing is inferred from a shared parent domain or hosting provider: app.shop.example and
// api.shop.example, a.vercel.app and b.vercel.app are different applications unless one is set as the project's API address.

/**
 * Whether a host name (no port; lower or mixed case) is the application's own: the app's host name itself, one of the known API host
 * names, or a host under the app's own name (api.shop.example for shop.example; www. dropped, so api.shop.example for www.shop.example).
 * An IP address or a one-label name (localhost) counts only by its exact name.
 */
export function ownAppHost(host: string, appHost: string, apiHosts: readonly string[] = []): boolean {
    const h = host.toLowerCase();
    const app = appHost.toLowerCase();
    const under = (name: string) => !!name && !/^[\d.]+$|^\[|:/.test(name) && name.includes(".") && h.endsWith(`.${name}`);
    return h === app || apiHosts.some((x) => x.toLowerCase() === h) || under(app) || under(app.replace(/^www\./, ""));
}
