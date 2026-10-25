// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { hash, readArtifact, readKnowledge, writeVault } from "./files.ts";

it("reads Obsidian originals with hashes, excluding generated snapshots and oversized context", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-team-knowledge-"));
  try {
    expect((await readKnowledge(root)).notes).toEqual([]);
    await NodeFSP.mkdir(NodePath.join(root, "notes", "teamwork-generated"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(root, "notes", "brief.md"),
      "Reuse the existing implementation",
    );
    await NodeFSP.writeFile(NodePath.join(root, "notes", "large.md"), "x".repeat(33 * 1024));
    await NodeFSP.writeFile(
      NodePath.join(root, "notes", "teamwork-generated", "old.md"),
      "Stale task state",
    );
    const result = await readKnowledge(root);
    expect(result.limited).toBe(true);
    expect(result.notes).toEqual([
      {
        path: "notes/brief.md",
        text: "Reuse the existing implementation",
        digest: hash("Reuse the existing implementation"),
      },
    ]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

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
