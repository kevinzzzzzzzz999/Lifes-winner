const base = require('../../electron-builder.cjs');
module.exports = {...base,
  directories:{...base.directories, app:'scripts/packaging/.probe', output:'scripts/packaging/.probe-output'},
  artifactName:'NOT-FOR-DISTRIBUTION-Probe-${os}-${arch}.${ext}',
  files:['main.cjs','index.html','package.json']
};
