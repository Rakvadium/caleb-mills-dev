#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "node:test";

const PASSED = 0;
const FAILED = 10;
const NO_MATCH = 11;
const SETUP = 12;

const root = path.resolve(import.meta.dirname, "..");
const INFRASTRUCTURE = [/Failed to fetch dynamically imported module/, /browserType\.launch/, /Browser connection was closed/];
const UNIT_ROOTS = ["app", "components"];

const [suite, mode, file, name] = process.argv.slice(2);
if (!["storybook", "unit"].includes(suite) || !["only", "except"].includes(mode) || !file || !name) {
  console.error("usage: test-case.mjs <storybook|unit> <only|except> <file> <exact test name>");
  process.exit(SETUP);
}

const target = { file: normalize(file), name };
try {
  const cases = suite === "storybook" ? storybookCases(mode === "only" ? [file] : []) : await unitCases(mode === "only" ? [file] : unitFiles());
  process.exit(judge(cases));
} catch (error) {
  console.error(error.message);
  process.exit(SETUP);
}

function judge({ cases, setupError }) {
  if (setupError !== undefined) {
    console.error(`setup error: ${setupError}`);
    return SETUP;
  }
  const matches = cases.filter((c) => c.file === target.file && c.name === target.name);
  if (matches.length !== 1) {
    console.error(`expected exactly one case named "${target.name}" in ${target.file}, found ${matches.length}`);
    return NO_MATCH;
  }
  const relevant = mode === "only" ? matches : cases.filter((c) => !(c.file === target.file && c.name === target.name));
  const infrastructure = relevant.find((c) => c.status === "failed" && INFRASTRUCTURE.some((pattern) => pattern.test(c.message)));
  if (infrastructure !== undefined) {
    console.error(`setup error in ${infrastructure.file} > ${infrastructure.name}: ${infrastructure.message.split("\n")[0]}`);
    return SETUP;
  }
  if (mode === "only" && matches[0].status !== "passed" && matches[0].status !== "failed") {
    console.error(`"${target.name}" did not run (${matches[0].status})`);
    return NO_MATCH;
  }
  const failed = relevant.filter((c) => c.status === "failed");
  for (const c of failed) {
    console.error(`failed: ${c.file} > ${c.name}`);
  }
  return failed.length === 0 ? PASSED : FAILED;
}

function storybookCases(files) {
  const out = mkdtempSync(path.join(tmpdir(), "test-case-"));
  const report = path.join(out, "report.json");
  try {
    spawnSync(
      process.execPath,
      [path.join(root, "node_modules", "vitest", "vitest.mjs"), "run", "--project=storybook", ...files, "--reporter=json", `--outputFile=${report}`],
      { cwd: root, stdio: ["ignore", "ignore", "inherit"], env: process.env },
    );
    if (!existsSync(report)) {
      return { cases: [], setupError: "vitest wrote no report" };
    }
    const parsed = JSON.parse(readFileSync(report, "utf8"));
    const broken = parsed.testResults.find((f) => f.assertionResults.length === 0 && f.status === "failed");
    if (broken !== undefined) {
      return { cases: [], setupError: `${normalize(broken.name)} failed to load: ${String(broken.message).split("\n")[0]}` };
    }
    return {
      cases: parsed.testResults.flatMap((f) =>
        f.assertionResults.map((a) => ({
          file: normalize(f.name),
          name: a.fullName,
          status: a.status,
          message: (a.failureMessages ?? []).join("\n"),
        })),
      ),
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

async function unitCases(files) {
  const cases = [];
  let setupError;
  for await (const event of run({ files: files.map((f) => path.resolve(root, f)) })) {
    if (event.type !== "test:pass" && event.type !== "test:fail") {
      continue;
    }
    const data = event.data;
    const testFile = normalize(data.file ?? "");
    if (event.type === "test:fail" && data.name === data.file) {
      setupError = `${testFile} failed to load: ${String(data.details?.error?.message ?? "").split("\n")[0]}`;
      continue;
    }
    cases.push({
      file: testFile,
      name: data.name,
      status: data.skip || data.todo ? "skipped" : event.type === "test:pass" ? "passed" : "failed",
      message: String(data.details?.error?.message ?? ""),
    });
  }
  return { cases, setupError };
}

function unitFiles() {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".test.ts")) {
        found.push(path.relative(root, full));
      }
    }
  };
  for (const directory of UNIT_ROOTS) {
    walk(path.join(root, directory));
  }
  return found;
}

function normalize(p) {
  return path.relative(root, path.resolve(root, p)).split(path.sep).join("/");
}
