import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { addReleaseNotesToChangelog, versionPackages } from "./release-notes";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("addReleaseNotesToChangelog", () => {
  it("places release-level notes before the generated Changesets list", () => {
    const changelog = `# @orbisapp/remote-dsh

## 0.2.7

### Patch Changes

- abc1234: Fix Remote startup.
`;
    const releaseNotes = `### Upgrade Notes

Requires DeepSeek Harness 0.1.2-alpha.3+.

### New Features

- Add support-safe diagnostics export.
`;

    assert.equal(
      addReleaseNotesToChangelog(changelog, "0.2.7", releaseNotes),
      `# @orbisapp/remote-dsh

## 0.2.7

### Upgrade Notes

Requires DeepSeek Harness 0.1.2-alpha.3+.

### New Features

- Add support-safe diagnostics export.

### Patch Changes

- abc1234: Fix Remote startup.
`,
    );
  });

  it("keeps the generated changelog unchanged when release notes are empty", () => {
    const changelog = "# Package\n\n## 1.0.1\n\n### Patch Changes\n";
    assert.equal(addReleaseNotesToChangelog(changelog, "1.0.1", " \n"), changelog);
  });

  it("rejects headings that would split the generated version section", () => {
    assert.throws(
      () => addReleaseNotesToChangelog("# Package\n\n## 1.0.1\n", "1.0.1", "## Highlights"),
      /must use level 3/u,
    );
  });

  it("fails closed when the generated version heading is missing", () => {
    assert.throws(
      () => addReleaseNotesToChangelog("# Package\n", "1.0.1", "### Highlights\n\n- Added"),
      /could not find changelog heading/u,
    );
  });
});

describe("versionPackages", () => {
  it("composes and consumes release notes after Changesets versions the package", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "orbis-release-notes-"));
    temporaryDirectories.push(workspaceRoot);
    const releaseNotesPath = join(workspaceRoot, ".changeset", ".release-notes", "next.md");
    const packagePath = join(workspaceRoot, "packages", "orbis-remote-dsh");
    const manifestPath = join(packagePath, "package.json");
    const changelogPath = join(packagePath, "CHANGELOG.md");
    await mkdir(join(workspaceRoot, ".changeset", ".release-notes"), { recursive: true });
    await mkdir(packagePath, { recursive: true });
    await writeFile(releaseNotesPath, "### Highlights\n\n- Added diagnostics.\n", "utf8");
    await writeFile(manifestPath, '{"version":"0.2.6"}\n', "utf8");
    await writeFile(changelogPath, "# @orbisapp/remote-dsh\n", "utf8");

    await versionPackages({
      workspaceRoot,
      runChangesetVersion: async () => {
        await writeFile(manifestPath, '{"version":"0.2.7"}\n', "utf8");
        await writeFile(
          changelogPath,
          "# @orbisapp/remote-dsh\n\n## 0.2.7\n\n### Patch Changes\n\n- abc1234: Added diagnostics.\n",
          "utf8",
        );
      },
    });

    assert.equal(
      await readFile(changelogPath, "utf8"),
      "# @orbisapp/remote-dsh\n\n## 0.2.7\n\n### Highlights\n\n- Added diagnostics.\n\n### Patch Changes\n\n- abc1234: Added diagnostics.\n",
    );
    assert.equal(await readFile(releaseNotesPath, "utf8"), "");
  });
});
