// Packs Kothar into Kothar.app and a DMG (npm run package). The app folder it packs is laid out by scripts/stage.mjs.
//
// Signing switches on by itself. With a Developer ID certificate (CSC_LINK + CSC_KEY_PASSWORD, or CSC_NAME naming one
// in the keychain), the app is signed with the hardened runtime, and notarized when Apple credentials are set too
// (APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or
// APPLE_KEYCHAIN + APPLE_KEYCHAIN_PROFILE). With none of them, it gets an ad-hoc signature, which Apple Silicon needs to
// run it at all.
const env = process.env
const signed = Boolean(env.CSC_LINK || env.CSC_NAME)
const notarizable = Boolean(
  (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) ||
    (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) ||
    (env.APPLE_KEYCHAIN && env.APPLE_KEYCHAIN_PROFILE),
)
if (notarizable && !signed) console.warn('Apple credentials are set but no certificate (CSC_LINK or CSC_NAME): not notarizing')

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.billwang.kothar',
  productName: 'Kothar',
  // The Electron that `npm run desktop` runs, so the app ships what was tested.
  electronVersion: require('electron/package.json').version,
  copyright: 'Copyright © Bill Wang',
  directories: { app: 'build/app', output: 'release', buildResources: 'assets' },
  // Plain files: the core imports the built-in mods' TypeScript at startup, and the Browser mod hands Chromium its
  // extension folder and runs Playwright's CLI from disk, none of which work from inside an asar archive.
  asar: false,
  // Nothing native to rebuild; the staged node_modules is already exactly what ships.
  npmRebuild: false,
  files: ['**/*', '!**/*.map'],
  mac: {
    target: [{ target: 'dmg', arch: ['arm64'] }],
    category: 'public.app-category.developer-tools',
    icon: 'assets/icon.icns',
    minimumSystemVersion: '13.0',
    darkModeSupport: true,
    identity: signed ? undefined : '-',
    hardenedRuntime: signed,
    entitlements: 'assets/entitlements.mac.plist',
    entitlementsInherit: 'assets/entitlements.mac.plist',
    notarize: signed && notarizable,
  },
  dmg: {
    title: '${productName} ${version}',
    artifactName: '${productName}-${version}-${arch}.${ext}',
  },
}
