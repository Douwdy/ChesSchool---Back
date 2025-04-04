const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const cors = require('cors');
const chessEngine = require('./services/chessEngine');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 5001;

app.use(express.json());

const morgan = require('morgan');
app.use(morgan('dev'));

const corsOptions = {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Origin', 'Accept'],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use('/api', (req, res, next) => {
    console.log(`API Request: ${req.method} ${req.path}`);
    
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

const db = new sqlite3.Database('./data/puzzles.db');

// Ne pas réinitialiser le moteur ici car il est déjà initialisé dans le module
// La fonction initialize() est appelée dans le constructeur de ChessEngine

app.get('/problems', (req, res) => {
    const query = 'SELECT * FROM puzzles ORDER BY RANDOM() LIMIT 1';

    db.get(query, (err, row) => {
        if (err) {
            console.error('Erreur lors de la requête SQL :', err);
            return res.status(500).json({ error: 'Erreur lors du chargement du problème.' });
        }

        res.json(row);
    });
});

app.post('/api/analyze', async (req, res) => {
    const { fen, depth, moveTime } = req.body;
    
    if (!fen) {
        return res.status(400).json({ error: 'Position FEN requise' });
    }
    
    try {
        const result = await chessEngine.analyzePosition(fen, {
            depth: depth || 15,
            moveTime: moveTime || 1000,
            multipv: 3  // Ajout de multipv pour obtenir plusieurs variantes
        });
        
        res.json({
            bestMove: result.bestMove,
            evaluation: result.evaluation,
            bestMoves: result.bestMoves,  // Inclure les meilleures variantes
            fen: fen,
            analysisData: result.analysisData
        });
    } catch (error) {
        console.error('Erreur lors de l\'analyse:', error);
        res.status(500).json({ error: 'Erreur lors de l\'analyse: ' + error.message });
    }
});

app.get('/api/analysis-status', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendUpdate = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const clientId = Date.now();
  global.sseClients = global.sseClients || new Map();
  global.sseClients.set(clientId, sendUpdate);

  sendUpdate({ status: 'connected', clientId });

  req.on('close', () => {
    global.sseClients.delete(clientId);
  });
});

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
        
        const results = await chessEngine.analyzePGN(pgn, {
            depth: depth || 12,
            moveTime: moveTime || 500,
            onProgress: (data) => {
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
        
        console.log("Analyse terminée, nombre de positions:", results.analysis?.length || 0);
        
        if (!results.analysis) {
            throw new Error('Résultat d\'analyse incorrect');
        }
        
        // Inclure bestMoves dans les résultats formatés
        const formattedResults = results.analysis.map((result, index) => ({
            fen: result.fen,
            move: result.move,
            moveNumber: result.moveNumber,
            isWhite: result.isWhite,
            bestMove: result.bestMove,
            evaluation: result.evaluation,
            bestMoves: result.bestMoves || [],  // Inclure les meilleures variantes
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

let lastEngineRestart = Date.now();
const MIN_RESTART_INTERVAL = 60000;

app.get('/api/engine-health', (req, res) => {
  try {
    if (chessEngine.process && chessEngine.isReady) {
      res.json({ status: 'ok', message: 'Moteur d\'échecs opérationnel' });
    } else {
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

setInterval(() => {
  if (global.sseClients?.size === 0 && !chessEngine.currentAnalysis) {
    console.log('Redémarrage préventif du moteur d\'échecs');
    chessEngine.resetEngine();
    lastEngineRestart = Date.now();
  }
}, 3600000);

process.on('SIGINT', () => {
    console.log('Arrêt du serveur et du moteur d\'échecs...');
    chessEngine.shutDown();
    process.exit(0);
});

try {
    let privateKey, certificate, ca;
    
    try {
        privateKey = fs.readFileSync('/etc/letsencrypt/live/slashend.fr/privkey.pem', 'utf8');
        certificate = fs.readFileSync('/etc/letsencrypt/live/slashend.fr/cert.pem', 'utf8');
        ca = fs.readFileSync('/etc/letsencrypt/live/slashend.fr/chain.pem', 'utf8');
        console.log("Certificats chargés depuis le chemin du serveur VPS");
    } catch (e) {
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

    const httpsServer = https.createServer(credentials, app);

    httpsServer.listen(PORT, () => {
        console.log(`Serveur backend démarré sur https://slashend.fr:${PORT}`);
    });
} catch (error) {
    console.error("Impossible de démarrer le serveur HTTPS:", error);
    console.log("Démarrage du serveur HTTP uniquement...");
    
    app.listen(PORT, () => {
        console.log(`Serveur backend démarré sur http://localhost:${PORT}`);
    });
}