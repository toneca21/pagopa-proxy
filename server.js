import http from "http";
import { randomUUID } from "crypto";

const PORT = process.env.PORT || 3000;

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  // HEALTHCHECK
  if (req.url === "/healthz") {
    return json(res, 200, { ok: true, mode: "mock" });
  }

  // MOCK CREAZIONE PENDENZA
  if (req.url?.includes("/pendenze") && req.method === "POST") {
    return json(res, 200, {
      idPendenza: randomUUID(),
      iuv: "MOCK" + Math.floor(Math.random() * 1000000000),
      stato: "CREATA",
      ente: "mock-ente",
      importo: 25.5
    });
  }

  // MOCK VERIFICA PAGAMENTO
  if (req.url?.includes("/pagamenti")) {
    return json(res, 200, {
      stato: "PAGATO",
      timestamp: new Date().toISOString()
    });
  }

  // DEFAULT
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("PagoPA proxy MOCK running");
});

server.listen(PORT, () => {
  console.log(`MOCK PagoPA proxy running on port ${PORT}`);
});
