import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const pluginRoot = path.resolve(process.argv[2] ?? "codex-plugin");
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const mcpPath = path.join(pluginRoot, ".mcp.json");
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

if (!existsSync(manifestPath)) {
  errors.push("missing codex-plugin/.codex-plugin/plugin.json");
}

const manifest = existsSync(manifestPath)
  ? readJson(manifestPath, "plugin manifest")
  : null;

if (existsSync(mcpPath)) {
  if (manifest?.mcpServers !== "./.mcp.json") {
    errors.push(
      'plugin manifest must declare "mcpServers": "./.mcp.json" when .mcp.json exists',
    );
  }

  const mcp = readJson(mcpPath, ".mcp.json");
  if (mcp) {
    if ("mcp_servers" in mcp) {
      errors.push('.mcp.json must use Codex plugin field "mcpServers", not "mcp_servers"');
    }

    const servers = mcp.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      errors.push('.mcp.json must contain an object field "mcpServers"');
    } else {
      for (const [serverName, serverConfig] of Object.entries(servers)) {
        if (!serverConfig || typeof serverConfig !== "object" || Array.isArray(serverConfig)) {
          errors.push(`MCP server "${serverName}" must be an object`);
          continue;
        }

        if (serverName === "dev-context") {
          const headers = serverConfig.env_http_headers;
          const keyRef = headers?.["x-access-key"];
          if (keyRef !== "DEV_CONTEXT_MCP_KEY") {
            errors.push(
              'dev-context must reference DEV_CONTEXT_MCP_KEY via env_http_headers["x-access-key"]',
            );
          }
        }
      }
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Codex plugin validation passed: ${path.relative(process.cwd(), pluginRoot)}`);
