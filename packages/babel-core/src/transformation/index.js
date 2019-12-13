// @flow
import traverse from "@babel/traverse";
import typeof { SourceMap } from "convert-source-map";

import type { ResolvedConfig, PluginPasses } from "../config";

import PluginPass from "./plugin-pass";
import loadBlockHoistPlugin from "./block-hoist-plugin";
import normalizeOptions from "./normalize-opts";
import normalizeFile from "./normalize-file";

import generateCode from "./file/generate";
import type File from "./file/file";

export type FileResultCallback = {
  (Error, null): any,
  (null, FileResult | null): any,
};

export type FileResult = {
  metadata: {},
  options: {},
  ast: {} | null,
  code: string | null,
  map: SourceMap | null,
};

export function runAsync(
  config: ResolvedConfig,
  code: string,
  ast: ?(BabelNodeFile | BabelNodeProgram),
  callback: Function,
) {
  let result;
  try {
    result = runSync(config, code, ast);
  } catch (err) {
    return callback(err);
  }

  // We don't actually care about calling this synchronously here because it is
  // already running within a .nextTick handler from the transform calls above.
  return callback(null, result);
}

const crypto = require("crypto");
const fs = require("fs");
const cacheDir = "node_modules/.cache/babel";
fs.mkdirSync(cacheDir, { recursive: true });

export function runSync(
  config: ResolvedConfig,
  code: string,
  ast: ?(BabelNodeFile | BabelNodeProgram),
): FileResult {
  const filename = config.options.filename;
  const started = Date.now();
  const optsJSON = JSON.stringify(opts);
  const cacheKey = crypto
    .createHash("md5")
    .update(JSON.stringify(config))
    .update(code)
    .digest("hex");
  let cached;

  try {
    cached = {
      code: fs.readFileSync(`${cacheDir}/${cacheKey}.js`, "utf8"),
      map: JSON.parse(fs.readFileSync(`${cacheDir}/${cacheKey}.map`, "utf8")),
    };
  } catch (e) {
    cached = null;
  }

  if (cached) {
    console.log(
      `${filename} ${(cached.code.length / 1000).toFixed(
        1,
      )}kb restored in ${Date.now() - started}ms`,
    );
    return {
      metadata: {},
      options: opts,
      ast: null,
      code: cached.code,
      map: cached.map,
      sourceType: "module",
    };
  }

  const file = normalizeFile(
    config.passes,
    normalizeOptions(config),
    code,
    ast,
  );

  const opts = file.opts;
  try {
    transformFile(file, config.passes);
  } catch (e) {
    e.message = `${opts.filename ?? "unknown"}: ${e.message}`;
    if (!e.code) {
      e.code = "BABEL_TRANSFORM_ERROR";
    }
    throw e;
  }

  let outputCode, outputMap;
  try {
    if (opts.code !== false) {
      ({ outputCode, outputMap } = generateCode(config.passes, file));
    }
  } catch (e) {
    e.message = `${opts.filename ?? "unknown"}: ${e.message}`;
    if (!e.code) {
      e.code = "BABEL_GENERATE_ERROR";
    }
    throw e;
  }

  const result = {
    metadata: file.metadata,
    options: opts,
    ast: opts.ast === true ? file.ast : null,
    code: outputCode === undefined ? null : outputCode,
    map: outputMap === undefined ? null : outputMap,
    sourceType: file.ast.program.sourceType,
  };
  if (JSON.stringify(opts) !== optsJSON) {
    console.log(`PP: ${filename} NOT CACHED: opts changed`);
  } else if (JSON.stringify(result.metadata) !== "{}") {
    console.log(`PP: ${filename} NOT CACHED: metadata !== {}`);
  } else if (result.ast !== null) {
    console.log(`PP: ${filename} NOT CACHED: ast !== null`);
  } else if (result.sourceType !== "module") {
    console.log(`PP: ${filename} NOT CACHED: sourceType !== module`);
  } else {
    fs.writeFileSync(`${cacheDir}/${cacheKey}.js`, result.code);
    fs.writeFileSync(`${cacheDir}/${cacheKey}.map`, JSON.stringify(result.map));
    console.log(
      `${filename} ${(result.code.length / 1000).toFixed(
        1,
      )}kb cached to disk in ${Date.now() - started}ms`,
    );
  }
  return result;
}

function transformFile(file: File, pluginPasses: PluginPasses): void {
  for (const pluginPairs of pluginPasses) {
    const passPairs = [];
    const passes = [];
    const visitors = [];

    for (const plugin of pluginPairs.concat([loadBlockHoistPlugin()])) {
      const pass = new PluginPass(file, plugin.key, plugin.options);

      passPairs.push([plugin, pass]);
      passes.push(pass);
      visitors.push(plugin.visitor);
    }

    for (const [plugin, pass] of passPairs) {
      const fn = plugin.pre;
      if (fn) {
        const result = fn.call(pass, file);

        if (isThenable(result)) {
          throw new Error(
            `You appear to be using an plugin with an async .pre, ` +
              `which your current version of Babel does not support. ` +
              `If you're using a published plugin, you may need to upgrade ` +
              `your @babel/core version.`,
          );
        }
      }
    }

    // merge all plugin visitors into a single visitor
    const visitor = traverse.visitors.merge(
      visitors,
      passes,
      file.opts.wrapPluginVisitorMethod,
    );
    traverse(file.ast, visitor, file.scope);

    for (const [plugin, pass] of passPairs) {
      const fn = plugin.post;
      if (fn) {
        const result = fn.call(pass, file);

        if (isThenable(result)) {
          throw new Error(
            `You appear to be using an plugin with an async .post, ` +
              `which your current version of Babel does not support. ` +
              `If you're using a published plugin, you may need to upgrade ` +
              `your @babel/core version.`,
          );
        }
      }
    }
  }
}

function isThenable(val: mixed): boolean {
  return (
    !!val &&
    (typeof val === "object" || typeof val === "function") &&
    !!val.then &&
    typeof val.then === "function"
  );
}
