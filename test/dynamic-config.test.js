/**
 * Tests for dynamic Expo config (`app.config.ts`, `app.config.js`, `.cjs`, `.mjs`)
 * reading, AST editing, EAS project linking, Android package fixing, version
 * bumping, EAS version sync, and UI HTTP server routes.
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { promisify } = require('util');
const { execFile } = require('child_process');
const execFileAsync = promisify(execFile);
const ts = require('typescript');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const { readExpoConfig, invalidateExpoConfigCache } = require('../dist/core/expoConfig.js');
const { canEditExpoConfig } = require('../dist/core/expoConfigEdit.js');
const { detectEasLink } = require('../dist/core/easLink.js');
const { writeProjectIdToExpoConfig, assertCanLinkExpoConfig } = require('../dist/core/eas/link.js');
const { androidPackageCheck, setAndroidPackage, collectDoctorChecks, runDoctor } = require('../dist/commands/doctor.js');
const { bumpVersion } = require('../dist/core/bumpVersion.js');
const { syncEasVersion } = require('../dist/core/syncEasVersion.js');
const { uploadLocalKeystoreToEas } = require('../dist/core/keystore/easApiFetch.js');
const easApiMod = require('../dist/core/eas/api.js');
const { startUiServer } = require('../dist/server/server.js');

const TEST_PROJECT_ID = '70c1b5af-3884-404b-a268-bd6f875e4845';

function tmpDir(prefix = 'leb-dyn-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writePkgJson(dir, version = '1.0.0') {
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'dyn-test-app',
      version,
      dependencies: { expo: '52.0.0' },
    }, null, 2) + '\n',
    'utf8'
  );
}

/** Transpile TS/JS and evaluate the exported config so tests verify both syntax and runtime behavior. */
function evalTsOrJsConfig(filePath, baseConfig = {}) {
  const src = fs.readFileSync(filePath, 'utf8');
  const transpiled = ts.transpileModule(src, {
    fileName: filePath,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const errors = (transpiled.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  assert.strictEqual(errors.length, 0, `Transpile errors in ${path.basename(filePath)}: ${errors.map((e) => e.messageText).join('; ')}`);

  const mod = { exports: {} };
  const fn = new Function('exports', 'module', 'require', '__filename', '__dirname', transpiled.outputText);
  fn(mod.exports, mod, (id) => {
    if (id === 'expo/config') return {};
    if (id === '@expo/config-plugins') return { withPlugins: (cfg) => cfg };
    return {};
  }, filePath, path.dirname(filePath));

  const exported = mod.exports && mod.exports.default !== undefined ? mod.exports.default : mod.exports;
  return typeof exported === 'function' ? exported({ config: baseConfig }) : exported;
}

async function randomPort() {
  return await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

describe('app.config.* AST editing & EAS linking', () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); invalidateExpoConfigCache(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('links plain export default object in app.config.ts', () => {
    const cfgPath = path.join(dir, 'app.config.ts');
    fs.writeFileSync(cfgPath, [
      "import { ExpoConfig } from 'expo/config';",
      '',
      'export default {',
      "  name: 'My App',",
      "  slug: 'my-app',",
      "  version: '1.0.0',",
      '} satisfies ExpoConfig;',
      '',
    ].join('\n'), 'utf8');

    const { targetFile } = writeProjectIdToExpoConfig(dir, TEST_PROJECT_ID);
    assert.strictEqual(targetFile, 'app.config.ts');

    const evaluated = evalTsOrJsConfig(cfgPath);
    assert.strictEqual(evaluated.extra.eas.projectId, TEST_PROJECT_ID);
    assert.strictEqual(evaluated.name, 'My App');

    const link = detectEasLink(dir);
    assert.strictEqual(link.kind, 'linked');
    assert.strictEqual(link.projectId, TEST_PROJECT_ID);
    assert.strictEqual(link.source, 'dynamic');
  });

  it('links ({ config }: ConfigContext): ExpoConfig => ({ ...config, ... }) preserving ...config.extra', () => {
    const cfgPath = path.join(dir, 'app.config.ts');
    fs.writeFileSync(cfgPath, [
      "import { ExpoConfig, ConfigContext } from 'expo/config';",
      '',
      'export default ({ config }: ConfigContext): ExpoConfig => ({',
      '  ...config,',
      "  name: 'My App',",
      "  slug: 'my-app',",
      '});',
      '',
    ].join('\n'), 'utf8');

    writeProjectIdToExpoConfig(dir, TEST_PROJECT_ID);
    const updated = fs.readFileSync(cfgPath, 'utf8');
    assert.ok(updated.includes('...config.extra'), 'should spread ...config.extra');
    assert.ok(updated.includes('...config.extra?.eas'), 'should spread ...config.extra?.eas');

    const evaluated = evalTsOrJsConfig(cfgPath, {
      extra: { apiUrl: 'https://api.example.com', eas: { channel: 'prod' } },
    });
    assert.strictEqual(evaluated.extra.apiUrl, 'https://api.example.com');
    assert.strictEqual(evaluated.extra.eas.channel, 'prod');
    assert.strictEqual(evaluated.extra.eas.projectId, TEST_PROJECT_ID);
  });

  it('handles inline type object in signature, comments, and missing trailing commas', () => {
    const cfgPath = path.join(dir, 'app.config.ts');
    fs.writeFileSync(cfgPath, [
      'export default ({ config }: { config: Record<string, any> }): { name: string; [k: string]: any } => ({',
      '  ...config,',
      '  name: "Quoted App" // no trailing comma',
      '});',
      '',
    ].join('\n'), 'utf8');

    writeProjectIdToExpoConfig(dir, TEST_PROJECT_ID);
    const evaluated = evalTsOrJsConfig(cfgPath);
    assert.strictEqual(evaluated.name, 'Quoted App');
    assert.strictEqual(evaluated.extra.eas.projectId, TEST_PROJECT_ID);
  });

  it('handles block-body function, const indirection, and existing extra sibling keys', () => {
    const cfgPath = path.join(dir, 'app.config.ts');
    fs.writeFileSync(cfgPath, [
      "import { ExpoConfig, ConfigContext } from 'expo/config';",
      '',
      'export default function defineApp({ config }: ConfigContext): ExpoConfig {',
      '  const result: ExpoConfig = {',
      '    ...config,',
      "    name: 'Block App',",
      '    extra: {',
      '      ...config.extra,',
      '      router: { origin: false },',
      '    },',
      '  };',
      '  return result;',
      '}',
      '',
    ].join('\n'), 'utf8');

    writeProjectIdToExpoConfig(dir, TEST_PROJECT_ID);
    const evaluated = evalTsOrJsConfig(cfgPath, { extra: { fromAppJson: true } });
    assert.strictEqual(evaluated.extra.fromAppJson, true);
    assert.deepStrictEqual(evaluated.extra.router, { origin: false });
    assert.strictEqual(evaluated.extra.eas.projectId, TEST_PROJECT_ID);
  });

  it('handles multiple return branches without touching nested callbacks', () => {
    const cfgPath = path.join(dir, 'app.config.ts');
    fs.writeFileSync(cfgPath, [
      'export default ({ config }: any) => {',
      "  const items = ['a', 'b'].map((x) => ({ plugin: x }));",
      "  if (config.variant === 'dev') {",
      "    return { ...config, name: 'Dev App', items };",
      '  }',
      "  return { ...config, name: 'Prod App', items };",
      '};',
      '',
    ].join('\n'), 'utf8');

    writeProjectIdToExpoConfig(dir, TEST_PROJECT_ID);
    const dev = evalTsOrJsConfig(cfgPath, { variant: 'dev' });
    const prod = evalTsOrJsConfig(cfgPath, { variant: 'prod' });
    assert.strictEqual(dev.name, 'Dev App');
    assert.strictEqual(dev.extra.eas.projectId, TEST_PROJECT_ID);
    assert.strictEqual(prod.name, 'Prod App');
    assert.strictEqual(prod.extra.eas.projectId, TEST_PROJECT_ID);
    assert.deepStrictEqual(prod.items, [{ plugin: 'a' }, { plugin: 'b' }]);
  });

  it('supports app.config.js (module.exports), app.config.cjs, and app.config.mjs', () => {
    for (const [filename, content] of [
      ['app.config.js', "module.exports = ({ config }) => ({ ...config, name: 'JS App' });\n"],
      ['app.config.cjs', "module.exports = { name: 'CJS App', slug: 'cjs-app' };\n"],
      ['app.config.mjs', "export default { expo: { name: 'MJS App', slug: 'mjs-app' } };\n"],
    ]) {
      const sub = tmpDir('leb-ext-');
      try {
        const p = path.join(sub, filename);
        fs.writeFileSync(p, content, 'utf8');
        const { targetFile } = writeProjectIdToExpoConfig(sub, TEST_PROJECT_ID);
        assert.strictEqual(targetFile, filename);
        const link = detectEasLink(sub);
        assert.strictEqual(link.kind, 'linked');
        assert.strictEqual(link.projectId, TEST_PROJECT_ID);
      } finally {
        fs.rmSync(sub, { recursive: true, force: true });
      }
    }
  });

  it('checks existing projectId conflict (409) and allows overwrite when confirmed', () => {
    const cfgPath = path.join(dir, 'app.config.ts');
    fs.writeFileSync(cfgPath, [
      'export default {',
      "  name: 'Linked App',",
      "  slug: 'linked-app',",
      '  extra: {',
      '    eas: {',
      "      projectId: 'old-id-111',",
      '    },',
      '  },',
      '};',
      '',
    ].join('\n'), 'utf8');

    assert.throws(
      () => writeProjectIdToExpoConfig(dir, TEST_PROJECT_ID, false),
      (err) => err.status === 409 && /already linked.*old-id-111/i.test(err.message)
    );

    writeProjectIdToExpoConfig(dir, TEST_PROJECT_ID, true);
    const evaluated = evalTsOrJsConfig(cfgPath);
    assert.strictEqual(evaluated.extra.eas.projectId, TEST_PROJECT_ID);
  });

  it('gives an accurate filename error when dynamic config cannot be edited safely', () => {
    fs.writeFileSync(
      path.join(dir, 'app.config.ts'),
      "import buildConfig from './buildConfig';\nexport default buildConfig();\n",
      'utf8'
    );
    assert.strictEqual(canEditExpoConfig(dir), false);
    assert.throws(
      () => assertCanLinkExpoConfig(dir, TEST_PROJECT_ID),
      (err) => err.status === 409 && err.message.includes('app.config.ts') && err.message.includes(TEST_PROJECT_ID)
    );
  });
});

describe('app.config.ts + app.json precedence & full workflows', () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); invalidateExpoConfigCache(); writePkgJson(dir, '1.2.3'); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('prioritizes app.config.ts over app.json in readExpoConfig and detectEasLink', () => {
    fs.writeFileSync(
      path.join(dir, 'app.json'),
      JSON.stringify({ expo: { name: 'Hybrid App', slug: 'hybrid', android: { package: 'com.example.hybrid' } } }, null, 2),
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, 'app.config.ts'),
      [
        'export default ({ config }: any) => ({',
        '  ...config,',
        '  extra: {',
        '    ...config.extra,',
        '    eas: {',
        '      ...config.extra?.eas,',
        `      projectId: '${TEST_PROJECT_ID}',`,
        '    },',
        '  },',
        '});',
        '',
      ].join('\n'),
      'utf8'
    );

    const cfg = readExpoConfig(dir);
    assert.strictEqual(cfg.source, 'dynamic');
    assert.strictEqual(cfg.config.android.package, 'com.example.hybrid');
    assert.strictEqual(cfg.config.extra.eas.projectId, TEST_PROJECT_ID);

    const link = detectEasLink(dir);
    assert.strictEqual(link.kind, 'linked');
    assert.strictEqual(link.projectId, TEST_PROJECT_ID);
    assert.strictEqual(link.source, 'dynamic');
  });

  it('setAndroidPackage updates app.config.ts and doctor capabilities allow fixing it', async () => {
    const cfgPath = path.join(dir, 'app.config.ts');
    fs.writeFileSync(
      cfgPath,
      "export default ({ config }: any) => ({ ...config, name: 'NoPkg', slug: 'nopkg', version: '1.0.0' });\n",
      'utf8'
    );

    const before = await collectDoctorChecks(dir);
    assert.strictEqual(before.capabilities.canFixAndroidPackage, true);

    setAndroidPackage(dir, 'com.acme.tsapp');
    const pkgCheck = androidPackageCheck(dir);
    assert.strictEqual(pkgCheck.result.ok, true);
    assert.strictEqual(pkgCheck.pkg, 'com.acme.tsapp');
    assert.strictEqual(pkgCheck.source, 'dynamic');

    const evaluated = evalTsOrJsConfig(cfgPath);
    assert.strictEqual(evaluated.android.package, 'com.acme.tsapp');
  });

  it('doctor --fix sets android.package in app.config.ts when missing', async () => {
    const cfgPath = path.join(dir, 'app.config.ts');
    fs.writeFileSync(
      cfgPath,
      "export default {\n  name: 'FixTs',\n  slug: 'fix-ts',\n  version: '1.0.0',\n};\n",
      'utf8'
    );
    fs.mkdirSync(path.join(dir, 'android', 'app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'android', 'app', 'release.jks'), 'fake');
    fs.writeFileSync(
      path.join(dir, 'keystore.properties'),
      'storeFile=release.jks\nstorePassword=sp123\nkeyAlias=release\nkeyPassword=kp123\n'
    );
    fs.writeFileSync(
      path.join(dir, 'credentials.json'),
      JSON.stringify({
        android: { keystore: { keystorePath: 'android/app/release.jks', keystorePassword: 'sp123', keyAlias: 'release', keyPassword: 'kp123' } },
      })
    );

    const { results } = await runDoctor({ cwd: dir, dryRun: false, fixAll: true, skipUpdateCheck: true });
    const pkgRow = results.find((r) => r.name === 'Android package (app.config.*)');
    assert.ok(pkgRow && pkgRow.ok, 'doctor --fix should fix android.package in app.config.ts');
    const evaluated = evalTsOrJsConfig(cfgPath);
    assert.match(evaluated.android.package, /^com\.example\./);
  });

  it('bumpVersion and syncEasVersion work on app.config.ts-only project (no app.json)', async () => {
    const cfgPath = path.join(dir, 'app.config.ts');
    fs.writeFileSync(
      cfgPath,
      [
        'export default {',
        "  name: 'TsBuild',",
        "  slug: 'ts-build',",
        "  version: '1.2.3',",
        '  android: {',
        "    package: 'com.acme.tsbuild',",
        '  },',
        '  extra: {',
        '    eas: {',
        `      projectId: '${TEST_PROJECT_ID}',`,
        '    },',
        '  },',
        '};',
        '',
      ].join('\n'),
      'utf8'
    );
    const gradlePath = path.join(dir, 'android', 'app', 'build.gradle');
    fs.mkdirSync(path.dirname(gradlePath), { recursive: true });
    fs.writeFileSync(gradlePath, 'android {\n  defaultConfig {\n    versionCode 4\n    versionName "1.2.3"\n  }\n}\n', 'utf8');

    const bumped = await bumpVersion({ cwd: dir, skipEas: true });
    assert.strictEqual(bumped.versionName, '1.2.4');
    assert.strictEqual(bumped.versionCode, 5);
    assert.strictEqual(evalTsOrJsConfig(cfgPath).version, '1.2.4');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '1.2.4');

    const origGraphql = easApiMod.easGraphql;
    const calls = [];
    easApiMod.easGraphql = async (query, variables) => {
      calls.push({ query, variables });
      return { appVersion: { createAppVersion: { id: 'ver-1' } } };
    };
    try {
      await syncEasVersion({ cwd: dir });
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0].variables.appVersionInput, {
        appId: TEST_PROJECT_ID,
        platform: 'ANDROID',
        applicationIdentifier: 'com.acme.tsbuild',
        storeVersion: '1.2.4',
        buildVersion: '5',
      });
    } finally {
      easApiMod.easGraphql = origGraphql;
    }
  });

  it('uploadLocalKeystoreToEas reads android.package from app.config.ts', async () => {
    fs.writeFileSync(
      path.join(dir, 'app.config.ts'),
      "export default { name: 'UploadApp', slug: 'upload-app', android: { package: 'com.acme.upload' } };\n",
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, 'keystore.properties'),
      'storeFile=release.jks\nstorePassword=sp123\nkeyAlias=release\nkeyPassword=kp123\n'
    );
    await assert.rejects(
      () => uploadLocalKeystoreToEas(dir, TEST_PROJECT_ID),
      /was not found on disk/
    );
  });

  it('bumpVersion succeeds when app.config.ts omits version or has dynamic android.package', async () => {
    const cfgPath = path.join(dir, 'app.config.ts');
    fs.writeFileSync(
      cfgPath,
      [
        "import { withPlugins } from '@expo/config-plugins';",
        'export default withPlugins({',
        "  name: 'NoVerApp',",
        "  slug: 'no-ver-app',",
        '  android: {',
        "    package: 'com.acme.nover',",
        '  },',
        '}, []);',
        '',
      ].join('\n'),
      'utf8'
    );

    const resA = await bumpVersion({ cwd: dir, skipEas: true });
    assert.strictEqual(resA.versionName, '1.2.4');
    assert.strictEqual(evalTsOrJsConfig(cfgPath).version, '1.2.4');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '1.2.4');

    invalidateExpoConfigCache();
    fs.writeFileSync(
      cfgPath,
      [
        "const pkg = process.env.PKG || 'com.acme.dyn';",
        'export default {',
        "  name: 'DynPkg',",
        "  slug: 'dyn-pkg',",
        "  version: '2.0.0',",
        '  android: { package: pkg },',
        '};',
        '',
      ].join('\n'),
      'utf8'
    );
    const resB = await bumpVersion({ cwd: dir, skipEas: true });
    assert.strictEqual(resB.versionName, '2.0.1');
    assert.ok(fs.readFileSync(cfgPath, 'utf8').includes("version: '2.0.1'"));
  });

  it('scaffolded templates/scripts/bump-version.js handles app.config.ts without app.json', async () => {
    const cfgPath = path.join(dir, 'app.config.ts');
    fs.writeFileSync(
      cfgPath,
      "export default {\n  name: 'TplBump',\n  slug: 'tpl-bump',\n  version: '3.1.0',\n};\n",
      'utf8'
    );
    const gradlePath = path.join(dir, 'android', 'app', 'build.gradle');
    fs.mkdirSync(path.dirname(gradlePath), { recursive: true });
    fs.writeFileSync(gradlePath, 'android {\n  defaultConfig {\n    versionCode 10\n    versionName "3.1.0"\n  }\n}\n', 'utf8');
    const scriptsDir = path.join(dir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'templates', 'scripts', 'resolve-project-bin.js'), path.join(scriptsDir, 'resolve-project-bin.js'));
    fs.copyFileSync(path.join(__dirname, '..', 'templates', 'scripts', 'bump-version.js'), path.join(scriptsDir, 'bump-version.js'));

    await execFileAsync(process.execPath, [path.join(scriptsDir, 'bump-version.js')], { cwd: dir });
    assert.strictEqual(evalTsOrJsConfig(cfgPath).version, '3.1.1');
    const gradle = fs.readFileSync(gradlePath, 'utf8');
    assert.match(gradle, /versionCode 11/);
    assert.match(gradle, /versionName "3\.1\.1"/);

    // Must never invoke `eas build:version:set` with nonexistent non-interactive flags
    const tplSrc = fs.readFileSync(path.join(scriptsDir, 'bump-version.js'), 'utf8');
    const tplCode = tplSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/build:version:set|--version-code/.test(tplCode), 'bump-version.js must use GraphQL instead of interactive-only build:version:set');
  });

  it('scaffolded templates/scripts/bump-version.js skips EAS fetch when eas.json appVersionSource is not remote', async () => {
    const cfgPath = path.join(dir, 'app.config.ts');
    fs.writeFileSync(
      cfgPath,
      `export default {\n  name: 'LocalVer',\n  slug: 'local-ver',\n  version: '1.0.0',\n  android: { package: 'com.acme.localver' },\n  extra: { eas: { projectId: '${TEST_PROJECT_ID}' } },\n};\n`,
      'utf8'
    );
    fs.writeFileSync(path.join(dir, 'eas.json'), JSON.stringify({ cli: { appVersionSource: 'local' } }), 'utf8');
    const gradlePath = path.join(dir, 'android', 'app', 'build.gradle');
    fs.mkdirSync(path.dirname(gradlePath), { recursive: true });
    fs.writeFileSync(gradlePath, 'android {\n  defaultConfig {\n    versionCode 2\n    versionName "1.0.0"\n  }\n}\n', 'utf8');
    const scriptsDir = path.join(dir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'templates', 'scripts', 'resolve-project-bin.js'), path.join(scriptsDir, 'resolve-project-bin.js'));
    fs.copyFileSync(path.join(__dirname, '..', 'templates', 'scripts', 'bump-version.js'), path.join(scriptsDir, 'bump-version.js'));

    const { stdout } = await execFileAsync(process.execPath, [path.join(scriptsDir, 'bump-version.js')], { cwd: dir });
    assert.match(stdout, /appVersionSource is not "remote"/);
    assert.match(fs.readFileSync(gradlePath, 'utf8'), /versionCode 3/);
  });
});

describe('UI server REST routes with app.config.ts & upload guidance', () => {
  let dir;
  let serverInstance;

  beforeEach(async () => {
    dir = tmpDir('leb-ui-ts-');
    invalidateExpoConfigCache();
    writePkgJson(dir, '1.0.0');
    fs.writeFileSync(
      path.join(dir, 'app.config.ts'),
      [
        "import { ExpoConfig, ConfigContext } from 'expo/config';",
        '',
        'export default ({ config }: ConfigContext): ExpoConfig => ({',
        '  ...config,',
        "  name: 'UI TS App',",
        "  slug: 'ui-ts-app',",
        "  version: '1.0.0',",
        '});',
        '',
      ].join('\n'),
      'utf8'
    );
    serverInstance = await startUiServer({ cwd: dir, port: await randomPort(), openBrowser: false, quiet: true });
  });

  afterEach(async () => {
    if (serverInstance) await serverInstance.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('POST /api/eas/link updates app.config.ts, updates /api/status, and handles overwrite 409', async () => {
    const linkRes = await fetch(`${serverInstance.url}/api/eas/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: TEST_PROJECT_ID }),
    });
    assert.strictEqual(linkRes.status, 200);
    const linkData = await linkRes.json();
    assert.strictEqual(linkData.success, true);
    assert.strictEqual(linkData.projectId, TEST_PROJECT_ID);
    assert.strictEqual(linkData.targetFile, 'app.config.ts');

    const statusRes = await fetch(`${serverInstance.url}/api/status`);
    const statusData = await statusRes.json();
    assert.strictEqual(statusData.easLink.kind, 'linked');
    assert.strictEqual(statusData.easLink.projectId, TEST_PROJECT_ID);

    const conflictRes = await fetch(`${serverInstance.url}/api/eas/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: '11111111-1111-1111-1111-111111111111' }),
    });
    assert.strictEqual(conflictRes.status, 409);
    assert.match((await conflictRes.json()).error, /already linked/i);

    const overwriteRes = await fetch(`${serverInstance.url}/api/eas/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: '11111111-1111-1111-1111-111111111111', overwrite: true }),
    });
    assert.strictEqual(overwriteRes.status, 200);
    const evaluated = evalTsOrJsConfig(path.join(dir, 'app.config.ts'));
    assert.strictEqual(evaluated.extra.eas.projectId, '11111111-1111-1111-1111-111111111111');
  });

  it('POST /api/doctor/fix-package updates app.config.ts and returns targetFile', async () => {
    const pkgRes = await fetch(`${serverInstance.url}/api/doctor/fix-package`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageName: 'com.acme.uitsapp' }),
    });
    assert.strictEqual(pkgRes.status, 200);
    const data = await pkgRes.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.targetFile, 'app.config.ts');
    const evaluated = evalTsOrJsConfig(path.join(dir, 'app.config.ts'));
    assert.strictEqual(evaluated.android.package, 'com.acme.uitsapp');
  });

  it('UI index.html and app.js include configured-keystore Upload-to-EAS prompt and parse cleanly', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8');
    assert.ok(html.includes('id="ks-upload-configured-info"'));
    assert.ok(html.includes('id="btn-upload-sync-eas"'));
    assert.ok(appJs.includes('syncConfiguredKeystoreToEasWithPrompts'));
    assert.ok(appJs.includes('Upload to Sync to EAS'));
    new vm.Script(appJs, { filename: 'ui/app.js' });
  });
});
