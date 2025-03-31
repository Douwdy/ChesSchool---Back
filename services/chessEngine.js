const { spawn } = require('child_process');
const { Chess } = require('chess.js');
const path = require('path');
const fs = require('fs');

// Ajouter un watchdog pour surveiller l'état du moteur
class ChessEngine {
  constructor() {
    this.process = null;
    this.isReady = false;
    this.currentAnalysis = null;
    this.buffer = '';
    this.stockfishPath = null;
    this.analysisQueue = [];
    this.isProcessingQueue = false;
    this.lastActivityTime = Date.now();
    this.watchdogInterval = null;
  }

  initialize() {
    if (this.process) {
      // Arrêter le processus existant avant d'en créer un nouveau
      this.shutDown();
    }

    try {
      // Chemin du stockfish installé par npm
      const nodeModulesPath = path.resolve(__dirname, '../node_modules');
      
      // Vérifier si le module stockfish.js possède un binaire
      const possibleBinaryPaths = [
        path.join(nodeModulesPath, 'stockfish.js', 'bin', 'stockfish'),
        path.join(nodeModulesPath, 'stockfish.js', 'stockfish')
      ];

      // Chercher Stockfish dans le PATH
      const isWindows = process.platform === 'win32';
      const stockfishCommand = isWindows ? 'stockfish.exe' : 'stockfish';
      
      // Tenter d'utiliser le binaire Stockfish s'il est installé sur le système
      const localBinaryPath = path.join(__dirname, '../bin/stockfish');
        if (fs.existsSync(localBinaryPath)) {
        this.stockfishPath = localBinaryPath;
        } else {
        this.stockfishPath = stockfishCommand;
        }

      console.log(`Tentative d'exécution de Stockfish: ${this.stockfishPath}`);
      
      // Lancer le processus avec des options pour limiter les ressources
      this.process = spawn(this.stockfishPath, [], {
        // Ajouter un timeout en ms pour tuer le processus s'il ne répond pas
        timeout: 60000
      });
      
      // Gérer les erreurs du processus
      this.process.on('error', (error) => {
        console.error('Erreur du processus Stockfish:', error);
        this.process = null;
      });
      
      // Limiter la taille des buffers pour éviter les blocages
      this.process.stdout.setEncoding('utf8');
      // Configurer des timeouts de lecture si nécessaire
      this.process.stdout.setTimeout(10000);
      
      // Vérifier si le processus a démarré
      if (!this.process || !this.process.pid) {
        throw new Error('Impossible de lancer le processus Stockfish');
      }
      
      // Gérer la sortie du processus
      this.process.stdout.on('data', (data) => {
        const str = data.toString();
        this.buffer += str;
        
        // Traiter les lignes complètes
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop(); // Garder la dernière ligne incomplète
        
        for (const line of lines) {
          this.handleEngineOutput(line.trim());
        }
      });
      
      this.process.stderr.on('data', (data) => {
        console.error(`Erreur de Stockfish: ${data}`);
      });
      
      this.process.on('close', (code) => {
        console.log(`Processus Stockfish terminé avec le code ${code}`);
        this.process = null;
      });
      
      this.process.on('error', (error) => {
        console.error(`Erreur du processus Stockfish: ${error.message}`);
        this.process = null;
      });
      
      // Initialiser le moteur
      this.sendCommand('uci');
      this.sendCommand('isready');
      
      console.log('Moteur d\'échecs initialisé avec succès');
      
      // Démarrer le watchdog
      this.startWatchdog();
    } catch (error) {
      console.error('Erreur lors de l\'initialisation du moteur d\'échecs:', error);
      this.process = null;
    }
  }
  
  // Démarrer le watchdog
  startWatchdog() {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
    }
    
    this.lastActivityTime = Date.now();
    
    this.watchdogInterval = setInterval(() => {
      // Vérifier si le moteur a été actif dans les 2 minutes
      const inactiveTime = Date.now() - this.lastActivityTime;
      
      if (inactiveTime > 120000 && this.currentAnalysis) {
        console.warn(`Moteur inactif depuis ${inactiveTime/1000} secondes avec une analyse en cours`);
        
        // Tenter d'arrêter l'analyse
        this.sendCommand('stop');
        
        // Si toujours bloqué après 5 secondes, réinitialiser
        setTimeout(() => {
          if (this.currentAnalysis) {
            console.error('Réinitialisation du moteur après blocage');
            this.resetEngine();
          }
        }, 5000);
      }
    }, 30000); // Vérifier toutes les 30 secondes
  }
  
  // Mettre à jour l'horodatage d'activité
  updateActivity() {
    this.lastActivityTime = Date.now();
  }
  
  handleEngineOutput(line) {
    // Mettre à jour l'horodatage d'activité
    this.updateActivity();
    
    console.log('← Moteur:', line);
    
    if (line === 'readyok') {
      this.isReady = true;
    }
    
    if (this.currentAnalysis) {
      const { progress, completeCallback } = this.currentAnalysis;
      
      // Message "bestmove" indique la fin de l'analyse
      if (line.startsWith('bestmove')) {
        const bestMove = line.split(' ')[1];
        if (completeCallback) {
          completeCallback(bestMove);
        }
      }
      // Les messages "info" contiennent les analyses en cours
      else if (line.startsWith('info') && progress) {
        // Extraire l'évaluation et la profondeur
        let evaluation = null;
        let depth = null;
        
        const depthMatch = line.match(/depth (\d+)/);
        if (depthMatch) {
          depth = parseInt(depthMatch[1]);
        }
        
        // Score en centipawns
        const cpMatch = line.match(/score cp (-?\d+)/);
        if (cpMatch) {
          evaluation = parseInt(cpMatch[1]) / 100;
        }
        
        // Score mat
        const mateMatch = line.match(/score mate (-?\d+)/);
        if (mateMatch) {
          const mateIn = parseInt(mateMatch[1]);
          evaluation = mateIn > 0 ? `#${mateIn}` : `#-${Math.abs(mateIn)}`;
        }
        
        if (evaluation !== null && depth !== null) {
          progress({
            depth,
            evaluation,
          });
        }
      }
    }
  }

  sendCommand(command) {
    // Mettre à jour l'horodatage d'activité
    this.updateActivity();
    
    if (!this.process) {
      console.error('Le moteur n\'est pas initialisé');
      return;
    }
    
    console.log(`→ Commande: ${command}`);
    this.process.stdin.write(command + '\n');
  }

  analyzePosition(fen, options = {}) {
    return new Promise((resolve, reject) => {
      // Créer une tâche d'analyse
      const task = {
        execute: () => {
          // Implémentation actuelle de l'analyse
          return new Promise((taskResolve) => {
            if (!this.process) {
              this.initialize();
            }
            
            if (!this.process) {
              return reject(new Error('Impossible d\'initialiser le moteur d\'échecs'));
            }
            
            const depth = options.depth || 15;
            const moveTime = options.moveTime || 1000;
            
            let bestMove = null;
            let lastEvaluation = null;
            const analysisData = [];
            
            // Ajouter un drapeau pour savoir si l'analyse est terminée
            let analysisCompleted = false;
            
            // Commencer une analyse avec un timeout de sécurité plus robuste
            const timeoutId = setTimeout(() => {
              if (!analysisCompleted) {
                console.warn('Analyse bloquée, arrêt forcé');
                
                // Tenter d'envoyer la commande d'arrêt
                this.sendCommand('stop');
                
                // Attendre un peu, puis réinitialiser si nécessaire
                setTimeout(() => {
                  if (this.currentAnalysis) {
                    console.error('Le moteur ne répond pas, réinitialisation');
                    this.resetEngine();
                    this.currentAnalysis = null;
                    
                    taskResolve({
                      bestMove: null,
                      evaluation: 0,
                      timeout: true,
                      error: 'Timeout d\'analyse'
                    });
                  }
                }, 2000);
              }
            }, options.moveTime + 5000); // Un timeout plus long que le temps d'analyse prévu
            
            this.currentAnalysis = {
              progress: (data) => {
                lastEvaluation = data.evaluation;
                analysisData.push(data);
                
                if (options.onProgress) {
                  options.onProgress(data);
                }
              },
              completeCallback: (move) => {
                analysisCompleted = true;
                clearTimeout(timeoutId);
                bestMove = move;
                this.currentAnalysis = null;
                taskResolve({
                  bestMove,
                  evaluation: lastEvaluation,
                  analysisData
                });
              }
            };
            
            // Configurer le moteur et lancer l'analyse
            this.sendCommand('ucinewgame');
            this.sendCommand(`position fen ${fen}`);
            this.sendCommand(`go depth ${depth} movetime ${moveTime}`);
            
            // Ajouter un timeout de sécurité
            setTimeout(() => {
              if (this.currentAnalysis) {
                this.sendCommand('stop');
                this.currentAnalysis = null;
                taskResolve({
                  bestMove,
                  evaluation: lastEvaluation,
                  analysisData,
                  timeout: true
                });
              }
            }, moveTime + 1000);
          });
        },
        resolve,
        reject
      };
      
      // Ajouter à la file d'attente
      this.queueAnalysis(task);
    });
  }

  analyzePGN(pgn, options = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        console.log("Début de l'analyse PGN");
        
        const { Chess } = require('chess.js');
        const chess = new Chess();
        
        console.log("Tentative de chargement du PGN");
        
        // Déterminer la méthode à utiliser
        const loadMethod = typeof chess.loadPgn === 'function' ? 'loadPgn' : 
                           typeof chess.load_pgn === 'function' ? 'load_pgn' : null;
        
        if (!loadMethod) {
          console.error("Aucune méthode de chargement PGN trouvée");
          return reject(new Error('Méthode de chargement PGN non disponible'));
        }
        
        // Tenter de charger le PGN
        try {
          console.log(`Utilisation de la méthode ${loadMethod}`);
          chess[loadMethod](pgn);
          console.log("PGN chargé avec succès");
        } catch (e) {
          console.error("Erreur lors du chargement du PGN:", e);
          return reject(new Error(`Erreur lors du chargement PGN: ${e.message}`));
        }
        
        // Obtenir l'historique des coups
        const history = chess.history({ verbose: true });
        console.log("Nombre de coups extraits:", history.length);
        
        // Réinitialiser pour l'analyse
        chess.reset();
        const analysisResults = [];
        
        // Valider le PGN avant l'analyse
        let validPgn;
        try {
          // Nettoyer le PGN des caractères spéciaux problématiques
          validPgn = pgn.replace(/[\r\n\t]+/g, ' ')
                       .replace(/\s{2,}/g, ' ')
                       .trim();
        } catch (e) {
          return reject(new Error(`PGN invalide: ${e.message}`));
        }
        
        // Limiter le nombre de coups analysés pour éviter les blocages
        const maxMoves = options.maxMoves || 50;
        
        // Analyse coup par coup avec plus de sécurité
        for (let i = 0; i < Math.min(history.length, maxMoves); i++) {
          console.log(`Analyse du coup ${i+1}/${history.length}`);
          
          try {
            // Jouer le coup
            chess.move(history[i]);
            
            // Obtenir la position
            const fen = chess.fen();
            const turn = chess.turn();
            const moveNumber = Math.floor(i / 2) + 1;
            const isWhite = turn === 'w';
            
            // Analyser
            const positionAnalysis = await Promise.race([
              this.analyzePosition(fen, {
                depth: options.depth || 12,
                moveTime: options.moveTime || 500
              }),
              // Timeout individuel pour chaque analyse de position
              new Promise((_, timeoutReject) => 
                setTimeout(() => timeoutReject(new Error('Timeout d\'analyse de position')), 
                          (options.moveTime || 500) + 3000)
              )
            ]);
            
            console.log(`Coup ${i+1} analysé, évaluation:`, positionAnalysis.evaluation);
            
            // Stocker le résultat
            analysisResults.push({
              fen,
              move: history[i].san,
              moveNumber,
              isWhite,
              bestMove: positionAnalysis.bestMove,
              evaluation: positionAnalysis.evaluation
            });
            
            // Mise à jour progress
            if (options.onProgress) {
              options.onProgress({
                currentMove: i + 1,
                totalMoves: history.length,
                analysis: analysisResults[i]
              });
            }
          } catch (posError) {
            console.error(`Erreur lors de l'analyse de la position ${i+1}:`, posError);
            // Continuer avec la position suivante au lieu d'échouer complètement
            analysisResults.push({
              fen,
              move: history[i].san,
              moveNumber: Math.floor(i / 2) + 1,
              isWhite: chess.turn() === 'w',
              bestMove: null,
              evaluation: null,
              error: posError.message
            });
          }
        }
        
        console.log("Analyse PGN terminée, résultats:", analysisResults.length);
        resolve(analysisResults);
      } catch (error) {
        console.error("Erreur générale durant l'analyse PGN:", error);
        reject(error);
      }
    });
  }

  shutDown() {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
    
    if (this.process) {
      this.sendCommand('quit');
      // Attendre un peu puis forcer l'arrêt si nécessaire
      setTimeout(() => {
        if (this.process) {
          this.process.kill();
          this.process = null;
        }
      }, 500);
      this.isReady = false;
      console.log('Moteur d\'échecs arrêté');
    }
  }

  // Ajouter une méthode pour réinitialiser le moteur en cas de blocage
  resetEngine() {
    console.log('Réinitialisation du moteur d\'échecs...');
    this.shutDown();
    
    // Petit délai pour s'assurer que tout est nettoyé
    setTimeout(() => {
      this.initialize();
    }, 500);
  }

  // Méthode pour ajouter une analyse à la file d'attente
  queueAnalysis(task) {
    this.analysisQueue.push(task);
    this.processQueue();
  }
  
  // Méthode pour traiter la file d'attente
  async processQueue() {
    if (this.isProcessingQueue || this.analysisQueue.length === 0) {
      return;
    }
    
    this.isProcessingQueue = true;
    
    while (this.analysisQueue.length > 0) {
      const task = this.analysisQueue.shift();
      
      try {
        // Exécuter l'analyse
        const result = await task.execute();
        // Appeler le callback avec le résultat
        task.resolve(result);
      } catch (error) {
        // Gérer les erreurs
        console.error('Erreur dans la file d\'analyse:', error);
        task.reject(error);
        
        // Réinitialiser le moteur en cas d'erreur
        this.resetEngine();
      }
    }
    
    this.isProcessingQueue = false;
  }
}

// Créer une instance unique
const engineInstance = new ChessEngine();

module.exports = engineInstance;