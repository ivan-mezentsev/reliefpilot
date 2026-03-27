const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const test = process.argv.includes('--test');
const runtimeExternals = ['vscode', './xhr-sync-worker.js', 'grammy'];
const runtimePackages = ['grammy'];

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: runtimeExternals,
    logLevel: 'warning',
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
    ],
  });
  // build webview vendor (marked + highlight.js) - separate build because it's browser targeted
  await esbuild.build({
    entryPoints: ['src/webview/markdownDeps.ts'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    globalName: 'ReliefpilotMarkdownDeps',
    minify: production,
    sourcemap: false,
    outfile: 'media/markdown-deps.js',
    logLevel: 'warning',
  });
  // copy highlight.js css theme from node_modules
  await copyHighlightCss();
  // copy jsdom's xhr-sync-worker.js to dist
  await copyJsdomSyncWorker();
  if (watch) {
    await copyRuntimeDependencies(path.join(__dirname, 'dist', 'node_modules'));
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    await copyRuntimeDependencies(path.join(__dirname, 'dist', 'node_modules'));
  }
}

async function testBuild() {
  const ctx = await esbuild.context({
    entryPoints: ['src/**/*.ts'],
    bundle: true,
    format: 'cjs',
    minify: false,
    sourcemap: true,
    sourcesContent: false,
    platform: 'node',
    outdir: 'out',
    logLevel: 'warning',
    external: runtimeExternals,
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
    ],
  });
  // copy jsdom's xhr-sync-worker.js to out directory for tests
  await copyJsdomSyncWorkerForTests();
  await ctx.rebuild();
  await ctx.dispose();
  await copyRuntimeDependencies(path.join(__dirname, 'out', 'node_modules'));
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',

  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location == null) return;
        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      });
      console.log('[watch] build finished');
    });
  },
};

if (test) {
  testBuild().catch(e => {
    console.error(e);
    process.exit(1);
  });
} else {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}

async function copyHighlightCss() {
  try {
    const src = require.resolve('highlight.js/styles/github.css');
  const target = path.join(__dirname, 'media', 'highlight.github.css');
  fs.copyFileSync(src, target);
  } catch (e) {
  console.warn('[build] unable to copy highlight.js css', e && e.message ? e.message : e);
  }
}

async function copyJsdomSyncWorker() {
  try {
    // Find the xhr-sync-worker.js file from jsdom
    // require.resolve('jsdom') returns path like: /path/to/node_modules/jsdom/lib/api.js
    const jsdomPath = require.resolve('jsdom');
    // Get node_modules/jsdom directory
    const jsdomDir = path.dirname(path.dirname(jsdomPath));
    const src = path.join(jsdomDir, 'lib', 'jsdom', 'living', 'xhr', 'xhr-sync-worker.js');
    const target = path.join(__dirname, 'dist', 'xhr-sync-worker.js');

    // Ensure dist directory exists
    const distDir = path.dirname(target);
    if (!fs.existsSync(distDir)) {
      fs.mkdirSync(distDir, { recursive: true });
    }

    fs.copyFileSync(src, target);
    console.log('[build] copied xhr-sync-worker.js to dist/');
  } catch (e) {
    console.warn('[build] unable to copy xhr-sync-worker.js', e && e.message ? e.message : e);
  }
}

async function copyJsdomSyncWorkerForTests() {
  try {
    // Find the xhr-sync-worker.js file from jsdom
    const jsdomPath = require.resolve('jsdom');
    const jsdomDir = path.dirname(path.dirname(jsdomPath));
    const src = path.join(jsdomDir, 'lib', 'jsdom', 'living', 'xhr', 'xhr-sync-worker.js');
    const target = path.join(__dirname, 'out', 'xhr-sync-worker.js');

    // Ensure out directory exists
    const outDir = path.dirname(target);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    fs.copyFileSync(src, target);
    console.log('[build] copied xhr-sync-worker.js to out/');
  } catch (e) {
    console.warn('[build] unable to copy xhr-sync-worker.js', e && e.message ? e.message : e);
  }
}

async function copyRuntimeDependencies(targetNodeModulesDir) {
  for (const packageName of runtimePackages) {
    await copyRuntimePackageTree(packageName, targetNodeModulesDir);
  }
}

async function copyRuntimePackageTree(packageName, targetNodeModulesDir, seen = new Set()) {
  if (seen.has(packageName)) {
    return;
  }
  seen.add(packageName);

  const packageRoot = resolvePackageRoot(packageName);
  if (!packageRoot) {
    return;
  }
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const targetPackageDir = path.join(targetNodeModulesDir, packageName);

  fs.rmSync(targetPackageDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetPackageDir), { recursive: true });
  fs.cpSync(packageRoot, targetPackageDir, {
    recursive: true,
    filter: (source) => {
      const relativePath = path.relative(packageRoot, source);
      return relativePath === '' || !relativePath.split(path.sep).includes('node_modules');
    },
  });

  for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
    await copyRuntimePackageTree(dependencyName, targetNodeModulesDir, seen);
  }
}

function resolvePackageRoot(packageName) {
  const workspaceNodeModulesDir = path.resolve(__dirname, '..', '..', 'node_modules');
  const workspacePackageDir = path.join(workspaceNodeModulesDir, ...packageName.split('/'));
  const workspacePackageJson = path.join(workspacePackageDir, 'package.json');
  if (fs.existsSync(workspacePackageJson)) {
    return fs.realpathSync(workspacePackageDir);
  }

  const normalizedBuiltinNames = new Set([
    ...builtinModules,
    ...builtinModules.map((name) => name.replace(/^node:/, '')),
  ]);
  if (normalizedBuiltinNames.has(packageName)) {
    return null;
  }

  const resolvedEntry = require.resolve(packageName, { paths: [__dirname] });
  let currentDir = fs.realpathSync(path.dirname(resolvedEntry));

  while (true) {
    const candidate = path.join(currentDir, 'package.json');
    if (fs.existsSync(candidate)) {
      const packageJson = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (packageJson.name === packageName) {
        return currentDir;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Unable to resolve package root for ${packageName}`);
    }
    currentDir = parentDir;
  }
}

