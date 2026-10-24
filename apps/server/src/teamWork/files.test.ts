// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { hash, readArtifact, writeVault } from "./files.ts";

it("retains exact bytes after a source artifact is changed or deleted", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-team-capture-"));
  try {
    await NodeFSP.writeFile(NodePath.join(root, "result.md"), "已完成的产物\n");
    const saved = await readArtifact(root, "result.md");
    await NodeFSP.writeFile(NodePath.join(root, "result.md"), "later changes");
    await NodeFSP.unlink(NodePath.join(root, "result.md"));
    expect(Buffer.from(saved.base64, "base64").toString("utf8")).toBe("已完成的产物\n");
    expect(hash(Buffer.from(saved.base64, "base64"))).toBe(saved.digest);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("rejects traversal, absolute paths, directories, oversized files and a link outside the checkout", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-team-boundary-"));
  const outside = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-team-outside-"));
  try {
    await NodeFSP.writeFile(NodePath.join(outside, "private.md"), "outside");
    await NodeFSP.symlink(outside, NodePath.join(root, "link"), "junction");
    await NodeFSP.writeFile(NodePath.join(root, "large"), Buffer.alloc(512 * 1024 + 1));
    for (const path of [
      "../outside",
      "/absolute",
      "C:/absolute",
      "link/private.md",
      "large",
      "link",
      ".git/config",
    ])
      await expect(readArtifact(root, path)).rejects.toThrow();
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
    await NodeFSP.rm(outside, { recursive: true, force: true });
  }
});

it("exports repeatable Obsidian snapshots and preserves a manually edited snapshot", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-team-vault-"));
  try {
    const files = [
      ["index.md", "[[task-1]]"],
      ["artifacts/sha.md", "saved work"],
    ] as const;
    const directory = await writeVault(root, 3, files);
    expect(await writeVault(root, 3, files)).toBe(directory);
    expect(await NodeFSP.readFile(NodePath.join(directory, "artifacts/sha.md"), "utf8")).toBe(
      "saved work",
    );
    await NodeFSP.writeFile(NodePath.join(directory, "index.md"), "personal edits");
    await expect(writeVault(root, 3, files)).rejects.toThrow("edited");
    expect(await NodeFSP.readFile(NodePath.join(directory, "index.md"), "utf8")).toBe(
      "personal edits",
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
