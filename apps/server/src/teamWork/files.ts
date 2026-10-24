// @effect-diagnostics nodeBuiltinImport:off
// Native descriptors keep bounded capture and path identity checks in one I/O boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { reject } from "./model.ts";

export const hash = (bytes: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export async function readArtifact(root: string, relativePath: string) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.split("/").some((part) => part === ".." || part === ".git" || part === ".t3") ||
    NodePath.isAbsolute(normalized) ||
    /^[a-z]:/i.test(normalized)
  ) {
    reject("invalid", "Artifact paths must stay inside the task checkout.");
  }
  const canonicalRoot = await NodeFSP.realpath(root);
  const absolute = await NodeFSP.realpath(NodePath.resolve(canonicalRoot, normalized));
  const relative = NodePath.relative(canonicalRoot, absolute);
  if (
    relative.startsWith(`..${NodePath.sep}`) ||
    relative === ".." ||
    NodePath.isAbsolute(relative)
  )
    reject("invalid", "Artifact resolves outside the task checkout.");
  const file = await NodeFSP.open(absolute, "r");
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 512 * 1024)
      reject("invalid", "Each artifact must be a regular file of at most 512 KiB.");
    const buffer = Buffer.alloc(512 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await file.stat();
    if (
      length > 512 * 1024 ||
      length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino ||
      (await NodeFSP.realpath(NodePath.resolve(canonicalRoot, normalized))) !== absolute
    ) {
      reject("conflict", "Artifact changed during capture. Stop writers and submit again.");
    }
    const bytes = buffer.subarray(0, length);
    return {
      path: normalized,
      digest: hash(bytes),
      bytes: length,
      base64: bytes.toString("base64"),
    };
  } finally {
    await file.close();
  }
}

export async function writeVault(
  rootPath: string,
  revision: number,
  files: ReadonlyArray<readonly [string, string | Buffer]>,
) {
  const root = await NodeFSP.realpath(rootPath);
  let directory = root;
  for (const part of ["notes", "teamwork-generated", `revision-${revision}`, "artifacts"]) {
    directory = NodePath.join(directory, part);
    await NodeFSP.mkdir(directory).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EEXIST") throw cause;
    });
    if (
      (await NodeFSP.lstat(directory)).isSymbolicLink() ||
      !(await NodeFSP.stat(directory)).isDirectory()
    )
      reject("invalid", "Vault export directory must be a real project directory.");
  }
  directory = NodePath.dirname(directory);
  for (const [name, contents] of files) {
    const destination = NodePath.join(directory, name);
    try {
      await NodeFSP.writeFile(destination, contents, { flag: "wx" });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      if (
        (await NodeFSP.lstat(destination)).isSymbolicLink() ||
        !Buffer.from(await NodeFSP.readFile(destination)).equals(Buffer.from(contents))
      )
        reject("conflict", "An exported snapshot was edited. Preserve it before exporting again.");
    }
  }
  return directory;
}

export const artifactExportName = (digest: string, path: string) =>
  `artifacts/${digest}${NodePath.extname(path)
    .replace(/[^.a-zA-Z0-9_-]/g, "")
    .slice(0, 12)}`;
