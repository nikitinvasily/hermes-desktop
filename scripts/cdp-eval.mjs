#!/usr/bin/env node
// Minimal CDP eval driver for the packaged test instance (port 9333).
// Usage: node cdp-eval.mjs "<js expression>"
import http from "http";
import WebSocket from "ws";

const port = process.env.CDP_PORT || 9333;
const expr = process.argv[2];
if (!expr) {
  console.error("usage: node cdp-eval.mjs '<js>'");
  process.exit(2);
}

const targets = await new Promise((resolve, reject) => {
  http
    .get(`http://127.0.0.1:${port}/json/list`, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          reject(e);
        }
      });
    })
    .on("error", reject);
});
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("no page target");
  process.exit(1);
}
const w = new WebSocket(page.webSocketDebuggerUrl, {
  perMessageDeflate: false,
});
const pending = new Map();
w.on("message", (m) => {
  const j = JSON.parse(m.toString());
  if (j.id && pending.has(j.id)) {
    pending.get(j.id)(j);
    pending.delete(j.id);
  }
});
await new Promise((r) => w.on("open", r));
const r = await new Promise((resolve) => {
  pending.set(1, resolve);
  w.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: expr, returnByValue: true, awaitPromise: true },
    }),
  );
});
if (r.result?.exceptionDetails) {
  console.error(JSON.stringify(r.result.exceptionDetails, null, 2));
  process.exit(1);
}
console.log(r.result?.result?.value ?? JSON.stringify(r.result?.result));
w.close();
process.exit(0);
