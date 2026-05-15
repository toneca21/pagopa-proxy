import http from "http";

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("PagoPA proxy running");
});

server.listen(PORT, () => {
  console.log(`PagoPA proxy running on port ${PORT}`);
});
