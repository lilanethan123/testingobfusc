const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const app = express();

const maxSourceSize = Number(process.env.MAX_SOURCE_SIZE || 200_000);
const maxSourceLimit = process.env.MAX_SOURCE_LIMIT || "200kb";
const execTimeoutMs = Number(process.env.EXEC_TIMEOUT_MS || 10_000);
const prometheusDir = process.env.PROMETHEUS_DIR || process.cwd();
const luaBin =
  process.env.LUA_BIN || (process.platform === "win32" ? "lua" : "luajit");

const allowedPresets = new Set([
  "Minify",
  "Weak",
  "Vmify",
  "Medium",
  "Strong",
]);

app.use(express.json({ limit: maxSourceLimit }));
app.use(express.text({ type: ["text/*"], limit: maxSourceLimit }));

function getSource(req) {
  if (typeof req.body === "string") {
    return req.body;
  }
  if (req.body && typeof req.body.code === "string") {
    return req.body.code;
  }
  return null;
}

function getPreset(req) {
  const preset =
    (req.body && req.body.preset) ||
    (req.query && req.query.preset) ||
    "Minify";
  return String(preset);
}

function runPrometheus(inputPath, outputPath, preset) {
  return new Promise((resolve, reject) => {
    const args = ["./cli.lua", "--preset", preset, "--out", outputPath, inputPath];
    execFile(
      luaBin,
      args,
      { cwd: prometheusDir, timeout: execTimeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          const message = stderr || stdout || error.message || "Execution failed";
          const err = new Error(message);
          err.code = error.code;
          return reject(err);
        }
        resolve();
      }
    );
  });
}

app.post("/obfuscate", async (req, res) => {
  const source = getSource(req);
  if (typeof source !== "string" || source.trim().length === 0) {
    return res.status(400).send("Provide Lua source as text or {\"code\": \"...\"}.");
  }
  if (source.length > maxSourceSize) {
    return res.status(413).send("Source too large.");
  }

  const preset = getPreset(req);
  if (!allowedPresets.has(preset)) {
    return res
      .status(400)
      .send(`Unsupported preset. Use one of: ${[...allowedPresets].join(", ")}.`);
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "prometheus-"));
  const inputPath = path.join(tmpDir, "input.lua");
  const outputPath = path.join(tmpDir, "output.obfuscated.lua");

  try {
    await fs.writeFile(inputPath, source, "utf8");
    await runPrometheus(inputPath, outputPath, preset);
    const obfuscated = await fs.readFile(outputPath, "utf8");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send(obfuscated);
  } catch (err) {
    return res.status(500).send(String(err.message || err));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

app.get("/", (_req, res) => {
  res
    .status(200)
    .send("POST /obfuscate with Lua source (text/plain or JSON {code}).");
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Prometheus API listening on :${port}`);
});
