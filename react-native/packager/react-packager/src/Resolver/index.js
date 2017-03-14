/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */
'use strict';


const DependencyGraph = require('../node-haste');

const declareOpts = require('../lib/declareOpts');
const defaults = require('../../../defaults');
const pathJoin = require('path').join;

// @Denis
const cwd = process.cwd();
const appName = require(`${cwd}/package.json`).name;

const validateOpts = declareOpts({
  projectRoots: {
    type: 'array',
    required: true,
  },
  blacklistRE: {
    type: 'object', // typeof regex is object
  },
  polyfillModuleNames: {
    type: 'array',
    default: [],
  },
  moduleFormat: {
    type: 'string',
    default: 'haste',
  },
  assetRoots: {
    type: 'array',
    default: [],
  },
  watch: {
    type: 'boolean',
    default: false,
  },
  assetExts: {
    type: 'array',
    required: true,
  },
  cache: {
    type: 'object',
    required: true,
  },
  transformCode: {
    type: 'function',
  },
  transformCacheKey: {
    type: 'string',
  },
  extraNodeModules: {
    type: 'object',
    required: false,
  },
  minifyCode: {
    type: 'function',
  },
  resetCache: {
    type: 'boolean',
    default: false,
  },
  // @Denis extenalModules
  extenalModules: {
    type: 'object',
    required: false,
    default: {},
  },
  // @Denis manifestReferrence
  manifestReferrence: {
    type: 'object',
    required: false,
  },
});

const getDependenciesValidateOpts = declareOpts({
  dev: {
    type: 'boolean',
    default: true,
  },
  platform: {
    type: 'string',
    required: false,
  },
  unbundle: {
    type: 'boolean',
    default: false,
  },
  recursive: {
    type: 'boolean',
    default: true,
  },
});

class Resolver {

  constructor(options) {
    const opts = validateOpts(options);

    this._depGraph = new DependencyGraph({
      roots: opts.projectRoots,
      assetRoots_DEPRECATED: opts.assetRoots,
      assetExts: opts.assetExts,
      ignoreFilePath: function(filepath) {
        return filepath.indexOf('__tests__') !== -1 ||
          (opts.blacklistRE && opts.blacklistRE.test(filepath));
      },
      providesModuleNodeModules: defaults.providesModuleNodeModules,
      platforms: defaults.platforms,
      preferNativePlatform: true,
      watch: opts.watch,
      cache: opts.cache,
      shouldThrowOnUnresolvedErrors: (_, platform) => platform !== 'android',
      transformCode: opts.transformCode,
      transformCacheKey: opts.transformCacheKey,
      extraNodeModules: opts.extraNodeModules,
      assetDependencies: ['react-native/Libraries/Image/AssetRegistry'],
      resetCache: options.resetCache,
      moduleOptions: {
        cacheTransformResults: true,
        resetCache: options.resetCache,
      },
    });
    // @Denis Bundler传入extenalModules 和 manifestReferrence #8
    this._extenalModules = opts.extenalModules;
    this._manifestReferrence = opts.manifestReferrence;
    this._minifyCode = opts.minifyCode;
    this._polyfillModuleNames = opts.polyfillModuleNames || [];

    this._depGraph.load().catch(err => {
      console.error(err.message + '\n' + err.stack);
      process.exit(1);
    });
  }

  getShallowDependencies(entryFile, transformOptions) {
    return this._depGraph.getShallowDependencies(entryFile, transformOptions);
  }

  stat(filePath) {
    return this._depGraph.getFS().stat(filePath);
  }

  getModuleForPath(entryFile) {
    return this._depGraph.getModuleForPath(entryFile);
  }

  getDependencies(entryPath, options, transformOptions, onProgress, getModuleId) {
    const {platform, recursive} = getDependenciesValidateOpts(options);
    return this._depGraph.getDependencies({
      entryPath,
      platform,
      transformOptions,
      recursive,
      onProgress,
    }).then(resolutionResponse => {
      this._getPolyfillDependencies().reverse().forEach(
        polyfill => resolutionResponse.prependDependency(polyfill)
      );

      resolutionResponse.getModuleId = getModuleId;
      return resolutionResponse.finalize();
    });
  }

  getModuleSystemDependencies(options) {
    const opts = getDependenciesValidateOpts(options);

    const prelude = opts.dev
        ? pathJoin(__dirname, 'polyfills/prelude_dev.js')
        : pathJoin(__dirname, 'polyfills/prelude.js');

    const moduleSystem = defaults.moduleSystem;

    return [
      prelude,
      moduleSystem,
    ].map(moduleName => this._depGraph.createPolyfill({
      file: moduleName,
      id: moduleName,
      dependencies: [],
    }));
  }

  _getPolyfillDependencies() {
    const polyfillModuleNames = defaults.polyfills.concat(this._polyfillModuleNames);

    return polyfillModuleNames.map(
      (polyfillModuleName, idx) => this._depGraph.createPolyfill({
        file: polyfillModuleName,
        id: polyfillModuleName,
        dependencies: polyfillModuleNames.slice(0, idx),
      })
    );
  }

  resolveRequires(resolutionResponse, module, code, dependencyOffsets = []) {
    const resolvedDeps = Object.create(null);

    // here, we build a map of all require strings (relative and absolute)
    // to the canonical ID of the module they reference
    resolutionResponse.getResolvedDependencyPairs(module)
      .forEach(([depName, depModule]) => {
        if (depModule) {
          // @Denis 以 Module name 替代
          // resolvedDeps[depName] = resolutionResponse.getModuleId(depModule);
          resolvedDeps[depName] = depModule.moduleName;
        }
      });

    // if we have a canonical ID for the module imported here,
    // we use it, so that require() is always called with the same
    // id for every module.
    // Example:
    // -- in a/b.js:
    //    require('./c') => require(3);
    // -- in b/index.js:
    //    require('../a/c') => require(3);
    // const replaceModuleId = (codeMatch, quote, depName) =>
    //   depName in resolvedDeps
    //     // @Denis
    //     // ? `${JSON.stringify(resolvedDeps[depName])} /* ${depName} */`
    //     ? `'${resolvedDeps[depName]}'`
    //     : codeMatch;
    // @Denis issue #8
    const replaceModuleId = (codeMatch, quote, depName) => {
      const resolvedDep = resolvedDeps[depName];

      if (resolvedDep) {
        const pkgName = resolvedDep.split('/')[0];
        // 如果有传入manifest.json 并且模块不属于manifest内定义的，并且模块不属于当前App，需要给模块追加命名空间
        return (this._manifestReferrence && !this._extenalModules[resolvedDep] && pkgName !== appName) ? `${appName}@${resolvedDep}'` : `'${resolvedDep}'`;
      } else {
        return codeMatch;
      }
      // return resolvedDep
        // @Denis
        // ? `${JSON.stringify(resolvedDeps[depName])} /* ${depName} */`
        // ? `'${resolvedDeps[depName]}'`
        // : codeMatch;
    }

    code = dependencyOffsets.reduceRight((codeBits, offset) => {
      const first = codeBits.shift();
      codeBits.unshift(
        first.slice(0, offset),
        first.slice(offset).replace(/(['"])([^'"']*)\1/, replaceModuleId),
      );
      return codeBits;
    }, [code]);

    return code.join('');
  }

  wrapModule({
    resolutionResponse,
    module,
    name,
    map,
    code,
    meta = {},
    dev = true,
    minify = false,
  }) {
    if (module.isJSON()) {
      code = `module.exports = ${code}`;
    }

    if (module.isPolyfill()) {
      code = definePolyfillCode(code);
    } else {
      const moduleId = resolutionResponse.getModuleId(module);
      code = this.resolveRequires(
        resolutionResponse,
        module,
        code,
        meta.dependencyOffsets
      );
      // @Denis issue #8
      // code = defineModuleCode(moduleId, code, name, dev);
      code = defineModuleCode(moduleId, code, name, dev, this._extenalModules, this._manifestReferrence);
    }


    return minify
      ? this._minifyCode(module.path, code, map)
      : Promise.resolve({code, map});
  }

  minifyModule({path, code, map}) {
    return this._minifyCode(path, code, map);
  }

  getDependencyGraph() {
    return this._depGraph;
  }
}
// @Denis issue #8
function defineModuleCode(moduleName, code, verboseName = '', dev = true, extenalModules, manifestReferrence) {
  const pkgName = verboseName.split('/')[0];
  // 如果有传入manifest.json 并且模块不属于manifest内定义的，并且模块不属于当前App，需要给模块追加命名空间
  if (manifestReferrence && !extenalModules[verboseName] && pkgName !== appName) {
    verboseName = `${appName}@${verboseName}`;
  }
  return [
    `__d(/* ${verboseName} */`,
    'function(global, require, module, exports) {', // module factory
      code,
    '\n}, ',
    // @Denis
    // `${JSON.stringify(moduleName)}`, // module id, null = id map. used in ModuleGraph
    `${JSON.stringify(verboseName)}`,
    dev ? `, null, ${JSON.stringify(verboseName)}` : '',
    ');',
  ].join('');
}

function definePolyfillCode(code,) {
  return [
    '(function(global) {',
    code,
    `\n})(typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : this);`,
  ].join('');
}

module.exports = Resolver;
