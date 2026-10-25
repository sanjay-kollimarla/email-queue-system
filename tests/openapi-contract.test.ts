import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

/** The published API contract (docs/openapi.yaml) and the real routes must never drift apart. */
const METHODS = ["get", "post", "patch", "delete"];

async function documented(): Promise<Set<string>> {
  const spec = Bun.YAML.parse(await Bun.file("docs/openapi.yaml").text()) as { paths: Record<string, Record<string, unknown>> };
  const out = new Set<string>();
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const method of Object.keys(ops)) {
      if (METHODS.includes(method)) out.add(`${method} ${path.replace(/\{(\w+)\}/g, ":$1")}`);
    }
  }
  return out;
}

async function implemented(): Promise<Set<string>> {
  const out = new Set<string>();
  const mounts: Record<string, string> = { "auth.ts": "/v1/auth", "smtp.ts": "/v1/smtp", "emails.ts": "/v1/emails" };
  const opsMounts: Record<string, string> = {
    statsRoutes: "/v1/stats",
    suppressionRoutes: "/v1/suppressions",
    dashboardRoutes: "/v1/dashboard",
  };
  for (const file of readdirSync("src/api/routes")) {
    const src = await Bun.file(`src/api/routes/${file}`).text();
    for (const m of src.matchAll(/app\.(get|post|patch|delete)\(\s*"([^"]+)"/g)) {
      let base = mounts[file] ?? "";
      if (file === "ops.ts") {
        const owner = [...src.slice(0, m.index).matchAll(/export function (\w+)\(/g)].pop()?.[1] ?? "";
        base = opsMounts[owner] ?? "";
      }
      const route = m[2] === "/" && base ? "" : m[2];
      out.add(`${m[1]} ${base}${route}`);
    }
  }
  return out;
}

describe("OpenAPI contract", () => {
  test("every route is documented", async () => {
    const docs = await documented();
    expect([...(await implemented())].filter((r) => !docs.has(r))).toEqual([]);
  });
  test("every documented operation exists", async () => {
    const code = await implemented();
    expect([...(await documented())].filter((r) => !code.has(r))).toEqual([]);
  });
});
