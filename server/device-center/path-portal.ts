import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";

export const PATH_HTML_LIMIT = 2 * 1024 * 1024;
export function parseDevicePath(value: string | undefined) {
	// Match the raw path: URL normalization must never turn an escape into a portal request.
	const match = /^\/device\/([a-z0-9][a-z0-9-]{0,62})(\/[^?#]*)?(\?[^#]*)?$/.exec(value || "");
	if (!match) return null;
	const tail = match[2] || "/";
	const capability = /^\/__relay\/([a-f0-9]{64})(\/.*)$/.exec(tail);
	return {
		id: match[1],
		tail,
		query: match[3] || "",
		token: capability?.[1],
		path: capability ? capability[2] + (match[3] || "") : undefined,
	};
}
export function capabilityBase(id: string, token: string) {
	return `/device/${id}/__relay/${token}/`;
}
export function portalHeaders(hub: URL, base: string): Record<string, string> {
	const http = hub.origin + base;
	const ws = http.replace(/^http/, "ws");
	return {
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		"access-control-allow-origin": "null",
		"access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
		"access-control-allow-headers":
			"content-type, authorization, x-requested-with, range, if-none-match, if-modified-since",
		"access-control-expose-headers": "content-type, content-length, content-range, accept-ranges, etag",
		"content-security-policy": `sandbox allow-scripts allow-forms allow-downloads; default-src 'none'; script-src ${http} 'unsafe-inline'; style-src ${http} 'unsafe-inline'; img-src ${http} data: blob:; font-src ${http} data:; media-src ${http} blob:; connect-src ${http} ${ws}; frame-src ${http}; form-action ${http}; base-uri ${http}; worker-src 'none'; object-src 'none'`,
		"x-content-type-options": "nosniff",
	};
}
export function wrapperHtml(base: string, initialPath = "") {
	const nonce = randomBytes(16).toString("hex");
	const html = `<!doctype html><html><head><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Device</title><style nonce="${nonce}">html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block}</style></head><body><iframe sandbox="allow-scripts allow-forms allow-downloads" referrerpolicy="no-referrer"></iframe><script nonce="${nonce}">const frame=document.querySelector('iframe');frame.src=${JSON.stringify(base + initialPath)}+location.hash;addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.origin!=='null')return;const data=event.data;if(!data||data.type!=='device-session-hash'||typeof data.hash!=='string'||!/^#s=[a-zA-Z0-9_-]{1,256}$/.test(data.hash))return;history.replaceState(null,'',location.pathname+data.hash)});</script></body></html>`;
	return {
		html,
		csp: `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
	};
}
export function transformPortalHtml(html: string, base: string) {
	// Remove upstream base tags so the first base always belongs to this capability.
	const content = html
		.replace(/<base\b[^>]*>/gi, "")
		.replace(
			/\b(src|href|action|poster)\s*=\s*(["'])\/(?!\/)([^"']*)\2/gi,
			(_all, name, quote, path) => `${name}=${quote}${base}${path}${quote}`,
		);
	return `<!doctype html><base href="${base}">` + content.replace(/<!doctype[^>]*>/i, "");
}
/** Only the entry HTML is collected; every other body retains relay streaming. */
export function createPortalResponse(res: ServerResponse, hub: URL, base: string, root: boolean) {
	let buffered = false;
	let status = 200;
	let headers: Record<string, string> = {};
	let chunks: Buffer[] = [];
	let bytes = 0;
	let started = false;
	return {
		start(code: number, upstream: Record<string, string>) {
			if (started) throw new Error("Duplicate portal response");
			started = true;
			status = code;
			headers = Object.fromEntries(
				Object.entries(upstream).filter(
					([key]) =>
						!/^(access-control-|content-security-policy|clear-site-data|service-worker-allowed|x-frame-options|refresh|content-location|link|reporting-endpoints|report-to|nel)/i.test(
							key,
						),
				),
			);
			if (headers.location) {
				const location = headers.location;
				if (!location.startsWith("/") || location.startsWith("//") || /[\\\r\n]/.test(location))
					throw new Error("Unsafe portal redirect");
				let decoded = location.split(/[?#]/)[0];
				for (let i = 0; i < 8; i++) {
					const next = decodeURIComponent(decoded);
					if (next === decoded) break;
					decoded = next;
				}
				if (/%|[\\\x00-\x20]/.test(decoded) || decoded.split("/").some((part) => part === "." || part === ".."))
					throw new Error("Unsafe portal redirect");
				headers.location = base + location.slice(1);
			}
			Object.assign(headers, portalHeaders(hub, base));
			buffered = root && /^(text\/html|application\/xhtml\+xml)\b/i.test(headers["content-type"] || "");
			if (buffered) {
				if (headers["content-encoding"] && headers["content-encoding"] !== "identity")
					throw new Error("Encoded portal HTML");
				delete headers["content-length"];
				delete headers["content-encoding"];
				delete headers.etag;
				headers["content-type"] = "text/html; charset=utf-8";
			} else {
				res.writeHead(status, headers);
				res.flushHeaders();
			}
		},
		write(data: Buffer) {
			if (!started) throw new Error("Missing portal headers");
			if (!buffered) {
				res.write(data);
				return;
			}
			bytes += data.length;
			if (bytes > PATH_HTML_LIMIT) throw new Error("Portal HTML exceeds 2 MiB");
			chunks.push(data);
		},
		end() {
			if (!started) throw new Error("Missing portal headers");
			if (buffered) {
				res.writeHead(status, headers);
				res.end(transformPortalHtml(Buffer.concat(chunks, bytes).toString("utf8"), base));
				chunks = [];
			} else res.end();
		},
	};
}
