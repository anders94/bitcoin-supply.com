const esbuild = require('esbuild');
esbuild.buildSync({
  entryPoints: ['public/javascripts/slider.ts', 'public/javascripts/quantum.ts', 'public/javascripts/charts.ts'],
  bundle: true,
  minify: true,
  outdir: 'public/javascripts/dist',
  platform: 'browser',
  target: ['es2020'],
});
