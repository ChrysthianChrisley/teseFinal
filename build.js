const fs = require('fs');
const path = require('path');

const dest = path.join(__dirname, 'www');
if (!fs.existsSync(dest)) {
  fs.mkdirSync(dest, { recursive: true });
}

const files = ['index.html', 'style.css', 'app.js', 'clean_foot.png', 'clean_foot_transparent.png'];
files.forEach(f => {
  const src = path.join(__dirname, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(dest, f));
    console.log(`Copiado: ${f} -> www/${f}`);
  }
});
console.log('Build www concluído!');
