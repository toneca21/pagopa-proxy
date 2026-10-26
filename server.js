// Micro-proxy mTLS multi-tenant per GovPay/Maggioli.
//
// UNICO scopo: ricevere una richiesta dal backend Lovable (TanStack server fn),
// scegliere il certificato client mTLS corretto per l'ente che la origina,
// inoltrarla a https://pagopa.paybill.it/... e restituire la risposta as-is.
//
// ZERO state, ZERO database, ZERO business logic, ZERO Express.
// Solo: auth header check + cert lookup + HTTPS forward.
//
// ─── CONFIG MULTI-ENTE ──────────────────────────────────────────────────────
//
// Per ogni ente registrare DUE env var:
//   CERT_<ID>_CRT_B64   → base64 del file .crt (PEM)
//   CERT_<ID>_KEY_B64   → base64 del file .key (PEM)
//
// Dove <ID> è lo slug uppercase corrispondente a `enti.pagopa_cert_id` nel DB.
// Esempi:
//   CERT_SEA_CRT_B64=...           ↔ enti.pagopa_cert_id = 'sea'
//   CERT_COMUNE_PISA_CRT_B64=...   ↔ enti.pagopa_cert_id = 'comune_pisa'
//
// La server function passa l'header `x-ente-cert-id: <slug>`.
// Il proxy fa lookup nella mappa caricata allo startup; se manca → 400.
//
// Backward-compat: se esistono PAGOPA_MTLS_CERT_B64/PAGOPA_MTLS_KEY_B64
// (cert legacy single-ente), vengono registrati come "default" e usati
// quando l'header `x-ente-cert-id` è assente.
// ────────────────────────────────────────────────────────────────────────────

import http from "node:http";
import https from "node:https";
import { Buffer } from "node:buffer";
import { URL } from "node:url";

const {
  PROXY_API_KEY,
  PAGOPA_BASE_URL,
  PAGOPA_MTLS_CERT_B64,
  PAGOPA_MTLS_KEY_B64,
  PORT = 8080,
} = process.env;

if (!PROXY_API_KEY || !PAGOPA_BASE_URL) {
  console.error("Missing required env: PROXY_API_KEY, PAGOPA_BASE_URL");
  process.exit(1);
}

// ─── Carica tutti i certificati dalle env vars ──────────────────────────────
/** @type {Map<string, https.Agent>} */
const agents = new Map();

function registerAgent(id, certB64, keyB64) {
  if (!certB64 || !keyB64) return false;
  try {
    const cert = Buffer.from(certB64, "base64").toString("utf8");
    const key = Buffer.from(keyB64, "base64").toString("utf8");
    agents.set(id, new https.Agent({ cert, key, keepAlive: true }));
    return true;
  } catch (e) {
    console.error(`[proxy] cert ${id}: invalid base64`, e.message);
    return false;
  }
}

// 1) legacy single-ente → default
if (PAGOPA_MTLS_CERT_B64 && PAGOPA_MTLS_KEY_B64) {
  if (registerAgent("default", PAGOPA_MTLS_CERT_B64, PAGOPA_MTLS_KEY_B64)) {
    console.log("[proxy] registered legacy default cert");
  }
}

// 2) multi-ente: scan CERT_<ID>_CRT_B64
for (const [k, v] of Object.entries(process.env)) {
  const m = k.match(/^CERT_(.+)_CRT_B64$/);
  if (!m || !v) continue;
  const id = m[1].toLowerCase();
  const keyVar = `CERT_${m[1]}_KEY_B64`;
  const keyB64 = process.env[keyVar];
  if (!keyB64) {
    console.warn(`[proxy] cert ${id}: ${keyVar} missing, skipping`);
    continue;
  }
  if (registerAgent(id, v, keyB64)) {
    console.log(`[proxy] registered cert: ${id}`);
  }
}

if (agents.size === 0) {
  console.error("[proxy] no certificates loaded — set CERT_<ID>_CRT_B64 / _KEY_B64 or legacy PAGOPA_MTLS_*");
  process.exit(1);
}

// ─── HTTP server ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Healthcheck (no auth) — esposto anche l'elenco degli ID caricati
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, certs: [...agents.keys()] }));
    return;
  }

  // Auth proxy
  if (req.headers["x-proxy-key"] !== PROXY_API_KEY) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  // Cert selection
  const enteCertId = (req.headers["x-ente-cert-id"] || "default").toString().toLowerCase();
  const agent = agents.get(enteCertId);
  if (!agent) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "unknown_cert_id",
      requested: enteCertId,
      available: [...agents.keys()],
    }));
    return;
  }

  // Read body
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const bodyBuf = Buffer.concat(chunks);

  // Forward to GovPay using https.request (real mTLS — globalThis.fetch
  // does NOT honor the `agent` option in undici, so the client cert was
  // never presented during the TLS handshake. https.request from node:https
  // uses the provided https.Agent and performs proper mTLS).
  const target = new URL(PAGOPA_BASE_URL.replace(/\/$/, "") + req.url);
  const isBodyMethod = !["GET", "HEAD"].includes(req.method);

  const upstreamReq = https.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      method: req.method,
      agent, // <-- mTLS agent con certificato client + chiave
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(isBodyMethod ? { "Content-Length": Buffer.byteLength(bodyBuf) } : {}),
      },
    },
    (upstream) => {
      const respChunks = [];
      upstream.on("data", (c) => respChunks.push(c));
      upstream.on("end", () => {
        const buf = Buffer.concat(respChunks);
        res.writeHead(upstream.statusCode || 502, {
          "Content-Type": upstream.headers["content-type"] || "application/json",
          "x-cert-used": enteCertId,
        });
        res.end(buf);
      });
    },
  );

  upstreamReq.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "proxy_failed",
        cert: enteCertId,
        message: String(err?.message || err),
      }),
    );
  });

  if (isBodyMethod) upstreamReq.write(bodyBuf);
  upstreamReq.end();
});

server.listen(Number(PORT), () => {
  console.log(`[proxy] mTLS multi-tenant on :${PORT} → ${PAGOPA_BASE_URL}`);
  console.log(`[proxy] certs loaded: ${[...agents.keys()].join(", ")}`);
});
