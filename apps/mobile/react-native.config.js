// WatermelonDB depends on the NPM-vendored `@nozbe/simdjson` fork rather than
// the CocoaPods-trunk `simdjson` pod. It ships its own podspec but isn't a
// full React Native module, so autolinking doesn't discover it on its own —
// without this, `pod install` fails looking for a `simdjson` spec on trunk.
// See: node_modules/@nozbe/watermelondb/WatermelonDB.podspec
module.exports = {
  dependencies: {
    '@nozbe/simdjson': {
      platforms: {
        ios: {
          podspecPath: require.resolve('@nozbe/simdjson/simdjson.podspec'),
        },
      },
    },
  },
};
