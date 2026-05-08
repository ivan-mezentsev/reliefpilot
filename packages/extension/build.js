const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const test = process.argv.includes("--test");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode", "./xhr-sync-worker.js"],
    logLevel: "warning",
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
    ],
  });
  // build webview vendor (marked + highlight.js + KaTeX) - separate build because it's browser targeted
  await esbuild.build({
    entryPoints: ["src/webview/markdownDeps.ts"],
    bundle: true,
    format: "iife",
    platform: "browser",
    globalName: "ReliefpilotMarkdownDeps",
    minify: production,
    sourcemap: false,
    outfile: "media/markdown-deps.js",
    logLevel: "warning",
  });
  // copy webview CSS/assets from node_modules
  await copyHighlightCss();
  await copyKatexAssets();
  // copy jsdom's xhr-sync-worker.js to dist
  await copyJsdomSyncWorker();
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

async function testBuild() {
  const ctx = await esbuild.context({
    entryPoints: ["src/**/*.ts"],
    bundle: true,
    format: "cjs",
    minify: false,
    sourcemap: true,
    sourcesContent: false,
    platform: "node",
    outdir: "out",
    logLevel: "warning",
    external: ["vscode", "./xhr-sync-worker.js"],
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
    ],
  });
  // copy jsdom's xhr-sync-worker.js to out directory for tests
  await copyJsdomSyncWorkerForTests();
  await ctx.rebuild();
  await ctx.dispose();
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location == null) return;
        console.error(
          `    ${location.file}:${location.line}:${location.column}:`,
        );
      });
      console.log("[watch] build finished");
    });
  },
};

if (test) {
  testBuild().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

const fs = require("node:fs");
const path = require("node:path");

async function copyHighlightCss() {
  try {
    const src = require.resolve("highlight.js/styles/github.css");
    const target = path.join(__dirname, "media", "highlight.github.css");
    fs.copyFileSync(src, target);
  } catch (e) {
    console.warn(
      "[build] unable to copy highlight.js css",
      e && e.message ? e.message : e,
    );
  }
}

async function copyKatexAssets() {
  try {
    const cssSrc = require.resolve("katex/dist/katex.min.css");
    const distDir = path.dirname(cssSrc);
    const fontsSrc = path.join(distDir, "fonts");
    const cssTarget = path.join(__dirname, "media", "katex.min.css");
    const fontsTarget = path.join(__dirname, "media", "fonts");

    fs.copyFileSync(cssSrc, cssTarget);
    fs.rmSync(fontsTarget, { recursive: true, force: true });
    fs.cpSync(fontsSrc, fontsTarget, { recursive: true });
  } catch (e) {
    console.warn(
      "[build] unable to copy KaTeX assets",
      e && e.message ? e.message : e,
    );
  }
}

async function copyJsdomSyncWorker() {
  try {
    const target = path.join(__dirname, "dist", "xhr-sync-worker.js");
    const jsdomPath = resolveOptionalModule("jsdom");
    if (!jsdomPath) {
      fs.rmSync(target, { force: true });
      return;
    }

    // Find the xhr-sync-worker.js file from jsdom
    // require.resolve('jsdom') returns path like: /path/to/node_modules/jsdom/lib/api.js
    // Get node_modules/jsdom directory
    const jsdomDir = path.dirname(path.dirname(jsdomPath));
    const src = path.join(
      jsdomDir,
      "lib",
      "jsdom",
      "living",
      "xhr",
      "xhr-sync-worker.js",
    );

    // Ensure dist directory exists
    const distDir = path.dirname(target);
    if (!fs.existsSync(distDir)) {
      fs.mkdirSync(distDir, { recursive: true });
    }

    fs.copyFileSync(src, target);
    console.log("[build] copied xhr-sync-worker.js to dist/");
  } catch (e) {
    console.warn(
      "[build] unable to copy xhr-sync-worker.js",
      e && e.message ? e.message : e,
    );
  }
}

async function copyJsdomSyncWorkerForTests() {
  try {
    const target = path.join(__dirname, "out", "xhr-sync-worker.js");
    const jsdomPath = resolveOptionalModule("jsdom");
    if (!jsdomPath) {
      fs.rmSync(target, { force: true });
      return;
    }

    // Find the xhr-sync-worker.js file from jsdom
    const jsdomDir = path.dirname(path.dirname(jsdomPath));
    const src = path.join(
      jsdomDir,
      "lib",
      "jsdom",
      "living",
      "xhr",
      "xhr-sync-worker.js",
    );

    // Ensure out directory exists
    const outDir = path.dirname(target);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    fs.copyFileSync(src, target);
    console.log("[build] copied xhr-sync-worker.js to out/");
  } catch (e) {
    console.warn(
      "[build] unable to copy xhr-sync-worker.js",
      e && e.message ? e.message : e,
    );
  }
}

function resolveOptionalModule(moduleName) {
  try {
    return require.resolve(moduleName);
  } catch (e) {
    if (e && e.code === "MODULE_NOT_FOUND") {
      return undefined;
    }

    throw e;
  }
}
