const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const cors = require('cors');
const chessEngine = require('./services/chessEngine');

const app = express();
const PORT = 5001;

// Activer le parsing JSON
app.use(express.json());

const morgan = require('morgan');
app.use(morgan('dev')); // Ajouter ceci pour voir toutes les requêtes HTTP

// Configuration de CORS
const corsOptions = {
    origin: (origin, callback) => {
        // Liste blanche des domaines autorisés
        const whitelist = [
            'http://localhost:3000', // Frontend local
            'http://127.0.0.1:3000' // Frontend local (IPv4)
        ];

        // Autoriser toutes les IP locales (192.168.x.x ou 10.x.x.x)
        const localNetworkRegex = /^http:\/\/(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/;

        if (!origin || whitelist.includes(origin) || localNetworkRegex.test(origin)) {
            callback(null, true); // Autoriser l'accès
        } else {
            callback(new Error('Accès refusé par CORS')); // Refuser l'accès
        }
    },
};

// Activer CORS avec les options configurées
app.use(cors(corsOptions));

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

// Démarrer le serveur
app.listen(PORT, () => {
    console.log(`Serveur backend démarré sur http://localhost:${PORT}`);
});