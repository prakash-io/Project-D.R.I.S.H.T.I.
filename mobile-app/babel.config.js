module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // Compile-time injection of .env into the `@env` module. React Native's
    // preset substitutes only NODE_ENV, so every other process.env.* read
    // resolved to undefined in the release bundle -- which is why the
    // Bhashini call went out with no Authorization header and came back 401.
    ['module:react-native-dotenv', {
      moduleName: '@env',
      path: '.env',
      safe: false,
      allowUndefined: true,
    }],

    // RETAINED, deliberately. The instruction to replace this file wholesale
    // would have dropped this plugin, and WatermelonDB models declare their
    // columns with legacy decorators (@field / @date in src/db/models/
    // TelemetryPoint.js and HazardReport.js). Without it the release bundle
    // fails to parse -- "Support for the experimental syntax 'decorators'
    // isn't currently enabled" -- which is a bug this project has already hit
    // once. Debug builds do not catch it because they skip bundling.
    ['@babel/plugin-proposal-decorators', { legacy: true }],
  ],
};
