import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordInstalledPluginIndexInstallOwner } from "../plugins/installed-plugin-index-install-owner.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { finalizePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { nativeAdmissionStateFor } from "../plugins/plugin-native-admission-state.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { loadGatewayStartupConfigSnapshot } from "./server-startup-config-helpers.js";
import { buildTestConfigSnapshot } from "./test-helpers.config-snapshots.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

it.each([true, false])(
  "preserves native capture policy across startup (managed=%s)",
  async (managed) => {
    const root = tempDirs.make("openclaw-startup-native-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
    const pluginRoot = path.join(root, "npm", "node_modules", "@fixture", "acpx");
    fs.mkdirSync(pluginRoot, { recursive: true });
    const source = path.join(pluginRoot, "index.js");
    const binary = path.join(pluginRoot, "helper.bin");
    const bytes = Buffer.alloc(4096, 0x5a);
    bytes.set([0x7f, 0x45, 0x4c, 0x46]);
    fs.writeFileSync(binary, bytes);
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({ name: "@fixture/acpx", version: "1.0.0", type: "module" }),
    );
    fs.writeFileSync(
      source,
      'export default { id: "acpx", register(api) { api.registerAutoEnableProbe(() => "fixture ACP configured"); } };\n',
    );
    const cache = createPluginCache();
    try {
      await withPluginCache(cache, async () => {
        const metadata = withArtifactPreservingStateReads(() => {
          const snapshot = createPluginMetadataSnapshotFixture({
            plugins: [
              { id: "acpx", origin: "global", rootDir: pluginRoot, source, setupSource: source },
            ],
          });
          snapshot.index = {
            ...snapshot.index,
            installRecords: managed ? { acpx: { source: "npm", installPath: pluginRoot } } : {},
            plugins: snapshot.index.plugins.map((record) =>
              managed ? recordInstalledPluginIndexInstallOwner({ ...record }, "acpx") : record,
            ),
          };
          snapshot.registryIndex = snapshot.index;
          return finalizePluginMetadataSnapshot(snapshot);
        });
        expect(
          withArtifactPreservingStateReads(() => nativeAdmissionStateFor(cache).managedRoots.size),
        ).toBe(Number(managed));
        expect(nativeAdmissionStateFor(cache).managedRoots.size).toBe(0);
        const config: OpenClawConfig = {
          acp: { enabled: true, backend: "acpx" },
          plugins: { allow: ["acpx"], entries: { acpx: { config: { fixture: true } } } },
        };
        const loaded = await loadGatewayStartupConfigSnapshot({
          minimalTestGateway: false,
          ambientEnvTriggers: "suppress",
          log: { info: vi.fn(), warn: vi.fn() },
          initialSnapshotRead: {
            snapshot: buildTestConfigSnapshot({
              path: path.join(root, "openclaw.json"),
              exists: true,
              raw: JSON.stringify(config),
              parsed: config,
              config,
              valid: true,
              issues: [],
              legacyIssues: [],
            }),
            pluginMetadataSnapshot: metadata,
          },
        });
        expect(loaded.snapshot.config.plugins?.entries?.acpx?.enabled).toBe(true);
        const targets = [...nativeAdmissionStateFor(cache).namespaces].flatMap(
          ([namespace, fact]) =>
            Object.entries(fact.members)
              .filter(([, member]) => member.source === binary)
              .map(([relative]) => path.join(namespace, "content", relative)),
        );
        expect(targets).toHaveLength(1);
        const [target] = targets;
        if (!target) {
          throw new Error("Native fixture was not captured");
        }
        const original = fs.statSync(binary);
        const captured = fs.statSync(target);
        expect(captured.dev === original.dev && captured.ino === original.ino).toBe(managed);
        const sourceManifest = fs.statSync(path.join(pluginRoot, "package.json"));
        const capturedManifest = fs.statSync(path.join(path.dirname(target), "package.json"));
        expect(capturedManifest.ino).not.toBe(sourceManifest.ino);
        expect(fs.readFileSync(binary)).toEqual(bytes);
      });
    } finally {
      const cleanup = await retirePluginCache(cache);
      expect(cleanup.failures).toEqual([]);
    }
  },
);
