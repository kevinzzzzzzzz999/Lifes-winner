// Windows packaging. Mac releases deliberately clone a pinned, complete Apple
// Silicon baseline bundle; see scripts/release/package.mjs and README.md.
const fs = require('node:fs/promises');
const path = require('node:path');
const work = path.join(__dirname, '.release-work');
const prepared = require(path.join(work, 'prepared-win.json'));
module.exports = {
  appId: 'org.inkspace.desktop', productName: '人生赢家',
  artifactName: 'Lifes-Winner-${version}-Windows-x64-Setup.${ext}',
  electronVersion: '44.3.0', electronDist: prepared.electronArchive,
  toolsets: { nsis: '1.2.1' },
  directories: { output: path.join(__dirname, 'release'), buildResources: path.join(__dirname, 'build') },
  asar: true, npmRebuild: true, nodeGypRebuild: false,
  beforeBuild: async () => false,
  files: ['package.json'],
  afterPack: async context => {
    await fs.copyFile(path.join(work, 'app.asar'), path.join(context.appOutDir, 'resources/app.asar'));
    await fs.rm(path.join(context.appOutDir, 'resources/default_app.asar'), { force: true });
  },
  extraResources: [{ from: prepared.resources, to: '.', filter: ['**/*'] }],
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: path.join(__dirname, 'build/icon.ico'), executableName: '人生赢家', signAndEditExecutable: true, signExecutable: false },
  nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: '人生赢家', deleteAppDataOnUninstall: false, displayLanguageSelector: true, installerLanguages: ['en_US', 'zh_CN'], license: path.join(__dirname, 'scripts/release/WINDOWS-NOTES.txt') },
  publish: null
};
