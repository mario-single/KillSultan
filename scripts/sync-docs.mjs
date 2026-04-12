import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

const checkOnly = process.argv.includes("--check");
const root = process.cwd();

const mappings = [
  {
    source: "docs/玩家规则手册.md",
    targets: ["apps/client/public/docs/玩家规则手册.md", "docs/rulebook-zh.md"],
  },
  {
    source: "docs/玩家规则手册.docx",
    targets: ["apps/client/public/docs/玩家规则手册.docx", "docs/rulebook-zh.docx"],
  },
  {
    source: "docs/图片命名规范.txt",
    targets: ["apps/client/public/docs/图片命名规范.txt", "apps/client/public/assets/roles/命名规范.txt"],
  },
  {
    source: "docs/lxhtodo.md",
    targets: ["apps/client/public/docs/lxhtodo.md"],
  },
  {
    source: "docs/AI交接记忆库.md",
    targets: ["apps/client/public/docs/AI交接记忆库.md"],
  },
  {
    source: "docs/面向开发者文档.md",
    targets: ["apps/client/public/docs/面向开发者文档.md"],
  },
];

function abs(rel) {
  return resolve(root, rel);
}

function hashFile(path) {
  if (!existsSync(path)) {
    return null;
  }
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex");
}

if (checkOnly) {
  const mismatches = [];
  for (const mapping of mappings) {
    const sourcePath = abs(mapping.source);
    if (!existsSync(sourcePath)) {
      throw new Error(`Missing source file: ${mapping.source}`);
    }
    const sourceHash = hashFile(sourcePath);
    for (const target of mapping.targets) {
      const targetPath = abs(target);
      const targetHash = hashFile(targetPath);
      if (sourceHash !== targetHash) {
        mismatches.push(`${mapping.source} != ${target}`);
      }
    }
  }
  if (mismatches.length > 0) {
    console.error("Unsynced docs:");
    for (const line of mismatches) {
      console.error(` - ${line}`);
    }
    process.exit(1);
  }
  console.log("Docs are in sync.");
  process.exit(0);
}

for (const mapping of mappings) {
  const sourcePath = abs(mapping.source);
  if (!existsSync(sourcePath)) {
    throw new Error(`Missing source file: ${mapping.source}`);
  }
  for (const target of mapping.targets) {
    const targetPath = abs(target);
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
    console.log(`Synced: ${mapping.source} -> ${target}`);
  }
}

console.log("Doc sync complete.");
