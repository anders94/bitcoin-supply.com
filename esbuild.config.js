const esbuild = require('esbuild');
esbuild.buildSync({
  entryPoints: [
    'public/javascripts/home.ts',
    'public/javascripts/header.ts',
    'public/javascripts/utxos.ts',
  ],
  bundle: true,
  minify: true,
  outdir: 'public/javascripts/dist',
  platform: 'browser',
  target: ['es2020'],
});
