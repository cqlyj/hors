import { normalizePath } from "../binding.js";
import type { Envelope } from "../envelope.js";
import { HorsError } from "../errors.js";

export interface ExpectedUrl {
  readonly host: string;
  readonly path: string;
}

export interface RequestLocation {
  readonly host: string | undefined;
  readonly forwardedHost: string | undefined;
  readonly path: string;
}

export function locationOf(request: Request): RequestLocation {
  const url = new URL(request.url);
  return {
    host: request.headers.get("host") ?? url.host,
    forwardedHost: request.headers.get("x-forwarded-host") ?? undefined,
    path: url.pathname,
  };
}

export interface ExpectedUrlOptions {
  readonly trustProxy: boolean;
  readonly origins?: readonly string[];
}

function hostnameOf(host: string): string | undefined {
  const candidate = `http://${host}`;
  if (!URL.canParse(candidate)) {
    return undefined;
  }
  return new URL(candidate).hostname;
}

function derivedHost(location: RequestLocation, trustProxy: boolean): string | undefined {
  if (trustProxy && location.forwardedHost !== undefined) {
    return location.forwardedHost.split(",")[0]?.trim();
  }
  return location.host;
}

export function expectedUrls(
  location: RequestLocation,
  options: ExpectedUrlOptions,
): ExpectedUrl[] {
  const origins = options.origins;
  if (origins !== undefined && origins.length > 0) {
    return origins.map((origin) => {
      const url = new URL(origin);
      return {
        host: url.host,
        path: url.pathname === "/" ? normalizePath(location.path) : normalizePath(url.pathname),
      };
    });
  }

  const host = derivedHost(location, options.trustProxy)?.toLowerCase();
  if (host === undefined || host === "") {
    throw new HorsError(
      "HORS_DOMAIN_MISMATCH",
      "expected URL could not be derived; configure origins",
    );
  }
  return [{ host, path: normalizePath(location.path) }];
}

export function matchExpectedUrl(
  envelope: Pick<Envelope, "domain" | "uri">,
  expected: readonly ExpectedUrl[],
): void {
  const signed = new URL(envelope.uri);

  const signedHost = signed.host;
  const signedPath = normalizePath(signed.pathname);
  const domain = envelope.domain.toLowerCase();
  for (const entry of expected) {
    const hostname = hostnameOf(entry.host);
    if (
      hostname !== undefined &&
      domain === hostname &&
      signedHost === entry.host &&
      signedPath === entry.path
    ) {
      return;
    }
  }

  // Ports compare literally: the envelope binds the host with its port. A Host:
  // example.com:443 header will not match https://example.com/… because URL
  // parsing drops the default port; deployers behind such proxies set origins.
  const reason = `expected ${expected.map((entry) => entry.host + entry.path).join(" or ")}; envelope signed ${domain} ${signedHost}${signedPath}`;
  throw new HorsError(
    "HORS_DOMAIN_MISMATCH",
    reason.length <= 1024 ? reason : reason.slice(0, 1024),
  );
}
