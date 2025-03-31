const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

// Créer le dossier bin s'il n'existe pas
const binDir = path.join(__dirname, 'bin');
if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir);
}

// Déterminer la plateforme
const platform = os.platform();
let stockfishUrl, stockfishBin;

if (platform === 'darwin') {
  // macOS
  stockfishUrl = 'https://github.com/official-stockfish/Stockfish/releases/download/sf_16/stockfish-macos-x86-64-avx2';
  stockfishBin = path.join(binDir, 'stockfish');
} else if (platform === 'win32') {
  // Windows
  stockfishUrl = 'https://github.com/official-stockfish/Stockfish/releases/download/sf_16/stockfish-windows-x86-64-avx2.exe';
  stockfishBin = path.join(binDir, 'stockfish.exe');
} else {
  // Linux
  stockfishUrl = 'https://github.com/official-stockfish/Stockfish/releases/download/sf_16/stockfish-ubuntu-x86-64-avx2';
  stockfishBin = path.join(binDir, 'stockfish');
}

console.log(`Téléchargement de Stockfish pour ${platform}...`);
console.log(`URL: ${stockfishUrl}`);
console.log(`Destination: ${stockfishBin}`);

// Télécharger Stockfish
const file = fs.createWriteStream(stockfishBin);
https.get(stockfishUrl, (response) => {
  response.pipe(file);
  
  file.on('finish', () => {
    file.close();
    console.log('Téléchargement terminé.');
    
    // Rendre le fichier exécutable sur Unix
    if (platform !== 'win32') {
      console.log('Attribution des droits d\'exécution...');
      fs.chmodSync(stockfishBin, 0o755);
    }
    
    console.log('Installation terminée ! Le moteur Stockfish est prêt à être utilisé.');
  });
}).on('error', (err) => {
  fs.unlinkSync(stockfishBin);
  console.error('Erreur lors du téléchargement:', err.message);
});