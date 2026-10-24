module.exports = {
  appId: 'org.inkspace.desktop',
  productName: '人生赢家',
  artifactName: 'InkSpace-Desktop-${version}-${os}-${arch}.${ext}',
  directories: { output: 'release', buildResources: 'build' },
  asar: true,
  npmRebuild: false,
  nodeGypRebuild: false,
  files: [
    'package.json', 'src/main/**/*', 'src/native/**/*.cjs', 'src/vendor/excel/**/*', 'src/preload/**/*', 'src/renderer/welcome-catalog.json', 'dist/renderer/**/*',
    '!**/*.map', '!**/.DS_Store', '!**/node_modules/**/{test,tests,example,examples}/**'
  ],
  extraResources: [
    { from: 'runtime/notebook/FILES.json', to: 'runtime/notebook/FILES.json' },
    { from: 'runtime/notebook/PROVENANCE.json', to: 'runtime/notebook/PROVENANCE.json' },
    { from: 'runtime/notebook/kernel.py', to: 'runtime/notebook/kernel.py' },
    { from: 'runtime/notebook/requirements-darwin-arm64.lock', to: 'runtime/notebook/requirements-darwin-arm64.lock' },
    { from: 'runtime/PROVENANCE.json', to: 'runtime/PROVENANCE.json' },
    { from: 'runtime/latex/PROVENANCE.json', to: 'runtime/latex/PROVENANCE.json' },
    { from: 'runtime/latex/basic-cache', to: 'runtime/latex/basic-cache' },
    { from: 'LICENSES', to: 'LICENSES' }
  ],
  mac: {
    target: [{ target: 'dmg', arch: ['arm64'] }],
    category: 'public.app-category.productivity',
    icon: 'build/icon.icns',
    minimumSystemVersion: '13.0',
    identity: null,
    hardenedRuntime: false,
    gatekeeperAssess: false,
    extraResources: [
      { from: 'runtime/notebook/darwin-arm64', to: 'runtime/notebook/darwin-arm64', filter: ['**/*', '!**/__pycache__/**', '!**/*.pyc'] },
      { from: 'runtime/python/darwin-arm64', to: 'runtime/python/darwin-arm64' },
      { from: 'runtime/native-ink/darwin-arm64', to: 'runtime/native-ink/darwin-arm64' },
      { from: 'runtime/latex/darwin-arm64', to: 'runtime/latex/darwin-arm64' }
    ]
  },
  dmg: {
    title: '人生赢家 0.8.5',
    icon: 'build/icon.icns',
    contents: [ { x: 140, y: 170 }, { x: 430, y: 170, type: 'link', path: '/Applications' } ]
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico',
    // electron-builder 26.15 uses cross-platform JavaScript resedit for icon and
    // version resources; signing remains disabled without invoking Wine/rcedit.
    signAndEditExecutable: true,
    signExecutable: false,
    extraResources: [
      { from: 'runtime/python/win32-x64', to: 'runtime/python/win32-x64' },
      { from: 'runtime/latex/win32-x64', to: 'runtime/latex/win32-x64' }
    ]
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: '人生赢家',
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    deleteAppDataOnUninstall: false,
    displayLanguageSelector: true,
    installerLanguages: ['en_US', 'zh_CN']
  }
};
