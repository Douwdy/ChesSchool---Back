const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const cors = require('cors');
const chessEngine = require('./services/chessEngine');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 5001;

// Activer le parsing JSON
app.use(express.json());

const morgan = require('morgan');
app.use(morgan('dev')); // Ajouter ceci pour voir toutes les requêtes HTTP

// Configuration CORS de base
const corsOptions = {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Origin', 'Accept'],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

// Gestion explicite des préflight requests pour toutes les routes
app.options('*', cors(corsOptions));

// Configuration CORS spécifique pour les routes /api
app.use('/api', (req, res, next) => {
    // Loguer les requêtes API pour débogage
    console.log(`API Request: ${req.method} ${req.path}`);
    
    // Headers CORS explicites pour les routes API
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Origin, Accept');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    next();
});

const apiRoutes = ['/api/analyze', '/api/analyze-game', '/api/analysis-status', '/api/engine-health'];

apiRoutes.forEach(route => {
    app.options(route, cors(corsOptions));
});

// Ouvrir la base de données SQLite
const db = new sqlite3.Database('./data/puzzles.db');

// Initialiser le moteur d'échecs au démarrage
chessEngine.initialize();

// Endpoint pour charger un problème d'échecs au hasard
app.get('/problems', (req, res) => {
    const query = 'SELECT * FROM puzzles ORDER BY RANDOM() LIMIT 1';

    db.get(query, (err, row) => {
        if (err) {
            console.error('Erreur lors de la requête SQL :', err);
            return res.status(500).json({ error: 'Erreur lors du chargement du problème.' });
        }

        res.json(row); // Envoyer le problème au client
    });
});

// Endpoint pour analyser une position d'échecs
app.post('/api/analyze', async (req, res) => {
    const { fen, depth, moveTime } = req.body;
    
    if (!fen) {
        return res.status(400).json({ error: 'Position FEN requise' });
    }
    
    try {
        const result = await chessEngine.analyzePosition(fen, {
            depth: depth || 15,
            moveTime: moveTime || 1000
        });
        
        res.json({
            bestMove: result.bestMove,
            evaluation: result.evaluation,
            fen: fen,
            analysisData: result.analysisData
        });
    } catch (error) {
        console.error('Erreur lors de l\'analyse:', error);
        res.status(500).json({ error: 'Erreur lors de l\'analyse: ' + error.message });
    }
});

// Ajouter une route pour les événements SSE
app.get('/api/analysis-status', (req, res) => {
  // Configuration des en-têtes pour SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Fonction pour envoyer des mises à jour au client
  const sendUpdate = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Ajouter ce client à la liste des clients connectés
  const clientId = Date.now();
  global.sseClients = global.sseClients || new Map();
  global.sseClients.set(clientId, sendUpdate);

  // Envoyer un message initial
  sendUpdate({ status: 'connected', clientId });

  // Nettoyer lors de la déconnexion
  req.on('close', () => {
    global.sseClients.delete(clientId);
  });
});

// Endpoint pour analyser une partie complète (PGN)
app.post('/api/analyze-game', async (req, res) => {
    const { pgn, depth, moveTime } = req.body;
    
    if (!pgn) {
        return res.status(400).json({ 
            success: false,
            error: 'PGN requis' 
        });
    }
    
    try {
        console.log("Analyse PGN reçue, longueur:", pgn.length);
        
        // Analyse de la partie
        const results = await chessEngine.analyzePGN(pgn, {
            depth: depth || 12,
            moveTime: moveTime || 500,
            onProgress: (data) => {
                // Envoyer les mises à jour à tous les clients connectés
                if (global.sseClients) {
                    const progressData = {
                        status: 'analyzing', 
                        currentMove: data.currentMove,
                        totalMoves: data.totalMoves,
                        progress: Math.floor((data.currentMove / data.totalMoves) * 100)
                    };
                    
                    global.sseClients.forEach(sendUpdate => {
                        sendUpdate(progressData);
                    });
                }
                console.log(`Progression: ${data.currentMove}/${data.totalMoves}`);
            }
        });
        
        console.log("Analyse terminée, nombre de positions:", results.length);
        
        // Assurez-vous que les résultats ont la structure attendue par le frontend
        const formattedResults = results.map((result, index) => ({
            fen: result.fen,
            move: result.move,
            moveNumber: result.moveNumber,
            isWhite: result.isWhite,
            bestMove: result.bestMove,
            evaluation: result.evaluation,
            // Ajouter d'autres informations utiles
            index: index
        }));
        
        res.json({
            success: true,
            analysis: formattedResults
        });
    } catch (error) {
        console.error('Erreur lors de l\'analyse du PGN:', error);
        res.status(500).json({ 
            success: false,
            error: 'Erreur lors de l\'analyse du PGN: ' + error.message 
        });
    }
});

// Dans le fichier server.js, ajouter un système de vérification d'état

// Variable pour stocker l'état du dernier redémarrage
let lastEngineRestart = Date.now();
const MIN_RESTART_INTERVAL = 60000; // Minimum 1 minute entre les redémarrages

// Endpoint pour vérifier l'état du moteur et le redémarrer si nécessaire
app.get('/api/engine-health', (req, res) => {
  try {
    if (chessEngine.process && chessEngine.isReady) {
      res.json({ status: 'ok', message: 'Moteur d\'échecs opérationnel' });
    } else {
      // Vérifier si on peut redémarrer le moteur
      const now = Date.now();
      if (now - lastEngineRestart > MIN_RESTART_INTERVAL) {
        console.log('Redémarrage du moteur d\'échecs...');
        chessEngine.resetEngine();
        lastEngineRestart = now;
        res.json({ status: 'restarted', message: 'Moteur d\'échecs redémarré' });
      } else {
        res.status(503).json({ 
          status: 'error', 
          message: 'Moteur d\'échecs indisponible, redémarrage trop récent'
        });
      }
    }
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Redémarrer périodiquement le moteur pour éviter les problèmes de mémoire
setInterval(() => {
  if (global.sseClients?.size === 0 && !chessEngine.currentAnalysis) {
    console.log('Redémarrage préventif du moteur d\'échecs');
    chessEngine.resetEngine();
    lastEngineRestart = Date.now();
  }
}, 3600000); // Toutes les heures

// Fermer proprement le moteur à l'arrêt du serveur
process.on('SIGINT', () => {
    console.log('Arrêt du serveur et du moteur d\'échecs...');
    chessEngine.shutDown();
    process.exit(0);
});

// Ajout du serveur HTTPS
try {
    // Tentative d'utilisation des certificats Let's Encrypt sur le VPS
    let privateKey, certificate, ca;
    
    try {
        // D'abord essayer le chemin sur le serveur VPS
        privateKey = fs.readFileSync('/etc/letsencrypt/live/slashend.fr/privkey.pem', 'utf8');
        certificate = fs.readFileSync('/etc/letsencrypt/live/slashend.fr/cert.pem', 'utf8');
        ca = fs.readFileSync('/etc/letsencrypt/live/slashend.fr/chain.pem', 'utf8');
        console.log("Certificats chargés depuis le chemin du serveur VPS");
    } catch (e) {
        // Si ça échoue, utiliser le chemin local dans le dossier du projet
        privateKey = fs.readFileSync(path.join(__dirname, 'ssl/privkey.pem'), 'utf8');
        certificate = fs.readFileSync(path.join(__dirname, 'ssl/cert.pem'), 'utf8');
        ca = fs.readFileSync(path.join(__dirname, 'ssl/chain.pem'), 'utf8');
        console.log("Certificats chargés depuis le dossier local ssl/");
    }

    const credentials = {
        key: privateKey,
        cert: certificate,
        ca: ca
    };

    // Créer serveur HTTPS
    const httpsServer = https.createServer(credentials, app);

    // Démarrer le serveur HTTPS
    httpsServer.listen(PORT, () => {
        console.log(`Serveur backend démarré sur https://slashend.fr:${PORT}`);
    });
} catch (error) {
    console.error("Impossible de démarrer le serveur HTTPS:", error);
    console.log("Démarrage du serveur HTTP uniquement...");
    
    // Démarrer le serveur HTTP comme fallback
    app.listen(PORT, () => {
        console.log(`Serveur backend démarré sur http://localhost:${PORT}`);
    });
}