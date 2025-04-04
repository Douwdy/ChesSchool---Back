const { spawn } = require('child_process');
const { Chess } = require('chess.js');
const path = require('path');
const fs = require('fs');

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
      this.shutDown();
    }

    try {
      const isMac = process.platform === 'darwin';
      const isWindows = process.platform === 'win32';
      
      if (isMac) {
        this.stockfishPath = 'stockfish';
        console.log('Environnement macOS détecté: utilisation de la commande stockfish du système');
      } else {
        const localBinaryPath = path.join(__dirname, '../bin/stockfish');
        if (fs.existsSync(localBinaryPath)) {
          this.stockfishPath = localBinaryPath;
          console.log(`Utilisation du binaire local Stockfish: ${this.stockfishPath}`);
        } else {
          const stockfishCommand = isWindows ? 'stockfish.exe' : 'stockfish';
          this.stockfishPath = stockfishCommand;
          console.log(`Binaire local non trouvé, utilisation de: ${this.stockfishPath}`);
        }
      }

      console.log(`Lancement du processus Stockfish: ${this.stockfishPath}`);
      
      this.process = spawn(this.stockfishPath, [], {
        timeout: 60000
      });
      
      this.process.on('error', (error) => {
        console.error('Erreur du processus Stockfish:', error);
        this.process = null;
      });
      
      this.process.stdout.setEncoding('utf8');
      this.process.stdout.setTimeout(10000);
      
      if (!this.process || !this.process.pid) {
        throw new Error('Impossible de lancer le processus Stockfish');
      }
      
      this.process.stdout.on('data', (data) => {
        const str = data.toString();
        this.buffer += str;
        
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop();
        
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
      
      this.sendCommand('uci');
      this.sendCommand('isready');
      
      console.log('Moteur d\'échecs initialisé avec succès');
      
      this.startWatchdog();
    } catch (error) {
      console.error('Erreur lors de l\'initialisation du moteur d\'échecs:', error);
      this.process = null;
    }
  }
  
  startWatchdog() {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
    }
    
    this.lastActivityTime = Date.now();
    
    this.watchdogInterval = setInterval(() => {
      const inactiveTime = Date.now() - this.lastActivityTime;
      
      if (inactiveTime > 120000 && this.currentAnalysis) {
        console.warn(`Moteur inactif depuis ${inactiveTime/1000} secondes avec une analyse en cours`);
        
        this.sendCommand('stop');
        
        setTimeout(() => {
          if (this.currentAnalysis) {
            console.error('Réinitialisation du moteur après blocage');
            this.resetEngine();
          }
        }, 5000);
      }
    }, 30000);
  }
  
  updateActivity() {
    this.lastActivityTime = Date.now();
  }
  
  handleEngineOutput(line) {
    this.updateActivity();
    
    console.log('← Moteur:', line);
    
    if (line === 'readyok') {
      this.isReady = true;
    }
    
    if (this.currentAnalysis) {
      const { progress, completeCallback } = this.currentAnalysis;
      
      if (line.startsWith('bestmove')) {
        const bestMove = line.split(' ')[1];
        if (completeCallback) {
          completeCallback(bestMove);
        }
      }
      else if (line.startsWith('info') && progress) {
        let evaluation = null;
        let depth = null;
        let multipvIndex = 0;
        let pv = null;
        
        const depthMatch = line.match(/depth (\d+)/);
        if (depthMatch) {
          depth = parseInt(depthMatch[1]);
        }
        
        const multipvMatch = line.match(/multipv (\d+)/);
        if (multipvMatch) {
          multipvIndex = parseInt(multipvMatch[1]);
        }
        
        const pvMatch = line.match(/pv ([a-h][1-8][a-h][1-8].*?)($| (?:bmc|depth|multipv|score|nodes|nps|tbhits|time))/);
        if (pvMatch) {
          pv = pvMatch[1];
        }
        
        const cpMatch = line.match(/score cp (-?\d+)/);
        if (cpMatch) {
          evaluation = parseInt(cpMatch[1]) / 100;
        }
        
        const mateMatch = line.match(/score mate (-?\d+)/);
        if (mateMatch) {
          const mateIn = parseInt(mateMatch[1]);
          evaluation = mateIn > 0 ? `#${mateIn}` : `#-${Math.abs(mateIn)}`;
        }
        
        if (evaluation !== null && depth !== null) {
          progress({
            depth,
            evaluation,
            multipv: multipvIndex,
            pv: pv
          });
        }
      }
    }
  }

  sendCommand(command) {
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
      const task = {
        execute: () => {
          return new Promise((taskResolve) => {
            if (!this.process) {
              this.initialize();
            }
            
            if (!this.process) {
              return reject(new Error('Impossible d\'initialiser le moteur d\'échecs'));
            }
            
            const depth = options.depth || 15;
            const moveTime = options.moveTime || 1000;
            const multipv = options.multipv || 1;
            
            let bestMove = null;
            let lastEvaluation = null;
            const analysisData = [];
            const bestMoves = [];
            
            let analysisCompleted = false;
            
            const timeoutId = setTimeout(() => {
              if (!analysisCompleted) {
                console.warn('Analyse bloquée, arrêt forcé');
                
                this.sendCommand('stop');
                
                setTimeout(() => {
                  if (this.currentAnalysis) {
                    console.error('Le moteur ne répond pas, réinitialisation');
                    this.resetEngine();
                    this.currentAnalysis = null;
                    
                    taskResolve({
                      bestMove: null,
                      evaluation: 0,
                      bestMoves: [],
                      timeout: true
                    });
                  }
                }, 2000);
              }
            }, options.moveTime + 5000);
            
            this.currentAnalysis = {
              progress: (data) => {
                const multipvIndex = data.multipv ? data.multipv - 1 : 0;
                
                if (multipvIndex === 0) {
                  lastEvaluation = data.evaluation;
                }
                
                bestMoves[multipvIndex] = {
                  move: data.pv ? data.pv.split(' ')[0] : null,
                  evaluation: data.evaluation
                };
                
                analysisData.push(data);
                
                if (options.onProgress) {
                  options.onProgress({...data, bestMoves});
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
                  bestMoves: bestMoves.filter(Boolean),
                  analysisData
                });
              }
            };
            
            this.sendCommand('setoption name MultiPV value ' + multipv);
            this.sendCommand('ucinewgame');
            this.sendCommand(`position fen ${fen}`);
            this.sendCommand(`go depth ${depth} movetime ${moveTime}`);
          });
        },
        resolve,
        reject
      };
      
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
        
        const loadMethod = typeof chess.loadPgn === 'function' ? 'loadPgn' : 
                           typeof chess.load_pgn === 'function' ? 'load_pgn' : null;
        
        if (!loadMethod) {
          return reject(new Error('Aucune méthode de chargement PGN disponible dans chess.js'));
        }
        
        try {
          chess[loadMethod](pgn);
        } catch (e) {
          return reject(new Error(`PGN invalide: ${e.message}`));
        }
        
        const history = chess.history({ verbose: true });
        console.log("Nombre de coups extraits:", history.length);
        
        chess.reset();
        const analysisResults = [];
        
        let validPgn;
        try {
          validPgn = pgn.replace(/[\r\n\t]+/g, ' ')
                       .replace(/\s{2,}/g, ' ')
                       .trim();
        } catch (e) {
          return reject(new Error(`PGN invalide: ${e.message}`));
        }
        
        const maxMoves = options.maxMoves || 50;
        
        for (let i = 0; i < Math.min(history.length, maxMoves); i++) {
          console.log(`Analyse du coup ${i+1}/${history.length}`);
          
          try {
            chess.move(history[i]);
            
            const fen = chess.fen();
            const turn = chess.turn();
            const moveNumber = Math.floor(i / 2) + 1;
            const isWhite = turn === 'w';
            
            const positionAnalysis = await Promise.race([
              this.analyzePosition(fen, {
                depth: options.depth || 12,
                moveTime: options.moveTime || 500,
                multipv: 3
              }),
              new Promise((_, timeoutReject) => 
                setTimeout(() => timeoutReject(new Error('Timeout d\'analyse de position')), 
                          (options.moveTime || 500) + 3000)
              )
            ]);
            
            console.log(`Coup ${i+1} analysé, évaluation:`, positionAnalysis.evaluation);
            
            analysisResults.push({
              fen,
              move: history[i].san,
              moveNumber,
              isWhite,
              bestMove: positionAnalysis.bestMove,
              evaluation: positionAnalysis.evaluation,
              bestMoves: positionAnalysis.bestMoves || []
            });
            
            if (options.onProgress) {
              options.onProgress({
                currentMove: i + 1,
                totalMoves: history.length,
                analysis: analysisResults[i]
              });
            }
          } catch (posError) {
            console.error(`Erreur lors de l'analyse de la position ${i+1}:`, posError);
            analysisResults.push({
              fen: chess.fen(),
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
        resolve({
          success: true,
          analysis: analysisResults
        });
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

  resetEngine() {
    console.log('Réinitialisation du moteur d\'échecs...');
    this.shutDown();
    
    setTimeout(() => {
      this.initialize();
    }, 500);
  }

  queueAnalysis(task) {
    this.analysisQueue.push(task);
    this.processQueue();
  }
  
  async processQueue() {
    if (this.isProcessingQueue || this.analysisQueue.length === 0) {
      return;
    }
    
    this.isProcessingQueue = true;
    
    while (this.analysisQueue.length > 0) {
      const task = this.analysisQueue.shift();
      
      try {
        const result = await task.execute();
        task.resolve(result);
      } catch (error) {
        console.error('Erreur dans la file d\'analyse:', error);
        task.reject(error);
        
        this.resetEngine();
      }
    }
    
    this.isProcessingQueue = false;
  }
}

const engineInstance = new ChessEngine();
engineInstance.initialize();
module.exports = engineInstance;