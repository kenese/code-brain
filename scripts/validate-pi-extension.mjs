import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const pkgRoot = path.resolve(process.argv[2] ?? "pi-extension");
const packageJsonPath = path.join(pkgRoot, "package.json");
const mcpPath = path.join(pkgRoot, ".mcp.json");
const errors = [];

function readJson(filePath, label) {
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${label} must contain a JSON object`);
      return null;
    }
    return value;
  } catch (error) {
    errors.push(`${label} must be valid JSON: ${error.message}`);
    return null;
  }
}

if (!existsSync(packageJsonPath)) {
  errors.push("missing pi-extension/package.json");
}

const pkg = existsSync(packageJsonPath) ? readJson(packageJsonPath, "package.json") : null;

if (pkg) {
  const extensions = pkg.pi?.extensions;
  if (!Array.isArray(extensions) || extensions.length === 0) {
    errors.push('package.json must declare a non-empty "pi.extensions" array');
  } else {
    for (const entry of extensions) {
      const entryPath = path.join(pkgRoot, entry);
      if (!existsSync(entryPath)) {
        errors.push(`pi.extensions entry "${entry}" does not exist at ${entryPath}`);
      }
    }
  }

  if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes("pi-package")) {
    errors.push('package.json should include "pi-package" in "keywords" for discoverability');
  }
}

if (existsSync(mcpPath)) {
  const mcp = readJson(mcpPath, ".mcp.json");
  if (mcp) {
    const servers = mcp.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      errors.push('.mcp.json must contain an object field "mcpServers"');
    } else if (servers["dev-context"]) {
      const headers = servers["dev-context"].headers;
      const keyRef = headers?.["x-access-key"];
      if (keyRef !== "${DEV_CONTEXT_MCP_KEY}") {
        errors.push(
          'dev-context must reference ${DEV_CONTEXT_MCP_KEY} via headers["x-access-key"] (pi-mcp-adapter only supports plain ${VAR} interpolation, not ${VAR:-default})',
        );
      }
      for (const [key, value] of Object.entries(headers ?? {})) {
        if (typeof value === "string" && /\$\{[A-Za-z_][A-Za-z0-9_]*:-/.test(value)) {
          errors.push(
            `.mcp.json header "${key}" uses bash-style \${VAR:-default} syntax, which pi-mcp-adapter does not support`,
          );
        }
      }
    }
  }
}

const scriptsDir = path.join(pkgRoot, "scripts");
for (const script of ["dev-context-connect.sh", "dev-context-watchdog.sh", "dev-context-checkpoint.sh"]) {
  if (!existsSync(path.join(scriptsDir, script))) {
    errors.push(`missing pi-extension/scripts/${script}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Pi extension validation passed: ${path.relative(process.cwd(), pkgRoot)}`);
