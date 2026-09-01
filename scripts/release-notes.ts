import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const RELEASE_NOTES_PATH = join(".changeset", ".release-notes", "next.md");
const PACKAGE_PATH = join("packages", "orbis-remote-dsh");

interface PackageManifest {
  readonly version?: unknown;
}

export interface VersionPackagesOptions {
  readonly workspaceRoot: string;
  readonly runChangesetVersion: () => Promise<void> | void;
}

function normalizeReleaseNotes(releaseNotes: string, lineEnding = "\n"): string {
  const normalized = releaseNotes.trim().replace(/\r?\n/gu, lineEnding);
  if (/^(?:#|##)(?:\s|$)/mu.test(normalized)) {
    throw new Error("release-note headings must use level 3 (`###`) or lower");
  }
  return normalized;
}

export function addReleaseNotesToChangelog(
  changelog: string,
  version: string,
  releaseNotes: string,
): string {
  const lineEnding = changelog.includes("\r\n") ? "\r\n" : "\n";
  const normalizedNotes = normalizeReleaseNotes(releaseNotes, lineEnding);
  if (normalizedNotes.length === 0) return changelog;

  const heading = `## ${version}`;
  const marker = `${heading}${lineEnding}`;
  const headingIndex = changelog.indexOf(marker);
  if (headingIndex === -1 || (headingIndex > 0 && changelog[headingIndex - 1] !== "\n")) {
    throw new Error(`could not find changelog heading ${JSON.stringify(heading)}`);
  }
  if (changelog.indexOf(marker, headingIndex + marker.length) !== -1) {
    throw new Error(`found duplicate changelog heading ${JSON.stringify(heading)}`);
  }

  const insertAt = headingIndex + heading.length;
  return `${changelog.slice(0, insertAt)}${lineEnding}${lineEnding}${normalizedNotes}${changelog.slice(insertAt)}`;
}

async function readPackageVersion(manifestPath: string): Promise<string> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`${manifestPath} does not declare a valid version`);
  }
  return manifest.version;
}

export async function versionPackages(options: VersionPackagesOptions): Promise<void> {
  const releaseNotesPath = join(options.workspaceRoot, RELEASE_NOTES_PATH);
  const packagePath = join(options.workspaceRoot, PACKAGE_PATH);
  const manifestPath = join(packagePath, "package.json");
  const changelogPath = join(packagePath, "CHANGELOG.md");
  const releaseNotes = normalizeReleaseNotes(await readFile(releaseNotesPath, "utf8"));
  const previousVersion = await readPackageVersion(manifestPath);

  await options.runChangesetVersion();

  const nextVersion = await readPackageVersion(manifestPath);
  if (nextVersion === previousVersion) {
    throw new Error(
      `changeset version did not update @orbisapp/remote-dsh from ${previousVersion}`,
    );
  }

  const changelog = await readFile(changelogPath, "utf8");
  const nextChangelog = addReleaseNotesToChangelog(changelog, nextVersion, releaseNotes);
  await writeFile(changelogPath, nextChangelog, "utf8");
  await writeFile(releaseNotesPath, "", "utf8");
}
