const path = require('path');
const fs = require('fs');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

// mobile-app/node_modules is a symlink into the primary checkout whenever this
// tree is a git worktree, so that parallel worktrees do not each carry their
// own ~1 GB install.
//
// Metro resolves a symlink to its real path before it starts walking parent
// directories looking for node_modules. The real path
// (/Users/.../drishti/mobile-app/node_modules) is not an ancestor of a
// worktree at .claude/worktrees/<name>/mobile-app, so that walk finds nothing
// and EVERY bare import fails:
//
//     Unable to resolve module @babel/runtime/helpers/interopRequireDefault
//     ... could not be found within the project or in these directories:
//       ../../../../../node_modules
//
// Debug builds hide this, because the Metro serving them is usually the one
// started in the primary checkout. It surfaces on `assembleRelease`, which
// bundles from whichever tree Gradle was invoked in.
//
// Naming both paths costs nothing in an ordinary checkout, where they are the
// same directory and this collapses to Metro's own default.
const moduleDir = path.resolve(__dirname, 'node_modules');
const realModuleDir = fs.existsSync(moduleDir) ? fs.realpathSync(moduleDir) : moduleDir;
const linked = realModuleDir !== moduleDir;

/**
 * Metro configuration
 * https://facebook.github.io/metro/docs/configuration
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = {
  resolver: {
    nodeModulesPaths: linked ? [moduleDir, realModuleDir] : [moduleDir],
  },
  // Metro refuses to read a file outside the project root unless it is watched.
  watchFolders: linked ? [realModuleDir] : [],
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
