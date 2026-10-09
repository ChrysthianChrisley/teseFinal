// build.js - Sincronização Unificada de Assets (Fonte Única da Verdade)
// Garante que qualquer atualização no site raiz seja 100% idêntica no APK e no GitHub Pages.
'use strict';
const fs = require('fs');
const path = require('path');

const root = __dirname;
const targetDirs = [
  path.join(root, 'www'),
  path.join(root, 'android/app/src/main/assets/public'),
  path.join(root, 'Apk_GPT/web'),
  path.join(root, 'Apk_GPT/android/app/src/main/assets/public')
];

const webFiles = [
  'index.html',
  'style.css',
  'app.js',
  'android.js',
  'clean_foot.png',
  'clean_foot_transparent.png'
];

function copyFolderRecursiveSync(source, target) {
  if (!fs.existsSync(source)) return;
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }
  const items = fs.readdirSync(source);
  items.forEach(item => {
    const srcPath = path.join(source, item);
    const dstPath = path.join(target, item);
    if (fs.lstatSync(srcPath).isDirectory()) {
      copyFolderRecursiveSync(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  });
}

console.log('🔄 Sincronizando scripts e assets entre a página do site e os projetos do APK...');

targetDirs.forEach(dest => {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  // Copia arquivos principais
  webFiles.forEach(file => {
    const src = path.join(root, file);
    const dst = path.join(dest, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    }
  });

  // Copia pasta de fontes
  const fontsSrc = path.join(root, 'fonts');
  const fontsDst = path.join(dest, 'fonts');
  copyFolderRecursiveSync(fontsSrc, fontsDst);

  console.log(` ✅ Sincronizado para: ${path.relative(root, dest) || dest}`);
});

// Atualiza capacitor.config.json e capacitor.plugins.json nos assets nativos se existirem
const nativeAssetDirs = [
  path.join(root, 'android/app/src/main/assets'),
  path.join(root, 'Apk_GPT/android/app/src/main/assets')
];

nativeAssetDirs.forEach(assetDir => {
  if (fs.existsSync(assetDir)) {
    const configSrc = path.join(root, 'capacitor.config.json');
    if (fs.existsSync(configSrc)) {
      fs.copyFileSync(configSrc, path.join(assetDir, 'capacitor.config.json'));
    }
    const pluginsJsonPath = path.join(assetDir, 'capacitor.plugins.json');
    if (!fs.existsSync(pluginsJsonPath)) {
      fs.writeFileSync(pluginsJsonPath, '[]\n');
    }
  }
});

console.log('🎉 Sincronização 100% concluída! Todos os scripts no site e no APK agora são idênticos.\n');
