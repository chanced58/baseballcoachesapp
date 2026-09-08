const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

// Support WatermelonDB's SQLite native module
config.resolver.unstable_enablePackageExports = false;

// Follow pnpm's content-addressed node_modules symlinks (workspace packages
// and hoisted deps live under the root node_modules/.pnpm store).
config.resolver.unstable_enableSymlinks = true;

// Force these to a single copy resolved from this app.
//
// Workspace packages (e.g. @baseball/ui) are compiled from source by Metro,
// so their own `import 'react'` resolves against *their* node_modules. Under
// pnpm's isolated layout that can be a different physical copy than the app's
// — two Reacts in one bundle, which fails at runtime with the very unhelpful
// "Cannot read property 'useContext' of null" from inside react-native's own
// View. Pinning here makes that structurally impossible rather than relying
// on every package's dep ranges staying in sync.
const SINGLETON_MODULES = ['react', 'react-dom', 'react-native'];

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const singleton = SINGLETON_MODULES.find(
    (name) => moduleName === name || moduleName.startsWith(`${name}/`),
  );
  if (singleton) {
    return context.resolveRequest(
      { ...context, originModulePath: path.join(__dirname, 'index.js') },
      moduleName,
      platform,
    );
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: './global.css' });
