import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const indexPath = path.join(process.cwd(), "dist", "index.html");

export const server = createServer((request, response) => {
  if (request.url !== "/" && request.url !== "/index.html") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  createReadStream(indexPath).pipe(response);
});
