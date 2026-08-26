module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // WatermelonDB models declare columns with legacy decorators
    // (@field / @date in src/db/models/). The RN preset does not enable
    // decorator syntax, so without this the release bundle fails to parse
    // — debug builds never caught it because they skip bundling entirely.
    ['@babel/plugin-proposal-decorators', { legacy: true }],
  ],
};
