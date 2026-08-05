import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production output is compiled to dist without Babel Standalone or JSX script tags", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /@babel\/standalone|babel\.min\.js|type="text\/babel"/i);
  assert.match(html, /FE Content Audit/);
  assert.doesNotMatch(html, /â|Â|Ã|ðŸ|ï¿½|�/);
});
