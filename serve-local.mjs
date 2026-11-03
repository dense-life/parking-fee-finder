import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const initialPort = Number(process.env.PARKING_TOOL_PORT || 8000);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const filePath = resolve(root, `.${requestedPath}`);
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("Forbidden");
      return;
    }
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
});

function listen(port) {
  const onListening = () => {
    console.log(`주차장 도구 로컬 미리보기: http://127.0.0.1:${port}/?demo=1`);
    console.log("종료하려면 Ctrl+C를 누르세요.");
  };
  server.once("error", (error) => {
    server.removeListener("listening", onListening);
    if (error.code === "EADDRINUSE" && !process.env.PARKING_TOOL_PORT && port < initialPort + 20) {
      console.log(`포트 ${port} 사용 중 · 다음 포트를 확인합니다.`);
      listen(port + 1);
      return;
    }
    console.error(`로컬 서버를 시작할 수 없습니다: ${error.message}`);
    process.exitCode = 1;
  });
  server.once("listening", onListening);
  server.listen(port, "127.0.0.1");
}

listen(initialPort);
