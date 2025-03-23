import express from 'express';
import multer from 'multer';
import { exec } from 'child_process';
import Stockfish from 'stockfish';
import fs from 'fs';
import { Chess } from 'chess.js';
import PDFDocument from 'pdfkit';

const app = express();
const port = 3000;
const upload = multer({ dest: 'uploads/' });

// Stockfish Initialization
const engine = Stockfish();
engine.onmessage = (message) => console.log("Stockfish: ", message);

// Upload PGN & Analyze
app.post('/analyze', upload.single('pgnFile'), async (req, res) => {
    try {
        const pgn = fs.readFileSync(req.file.path, 'utf8');
        const chess = new Chess();
        
        if (!chess.load_pgn(pgn)) {
            return res.status(400).json({ error: 'Invalid PGN file' });
        }
        
        // Analyze game with Stockfish
        const analysisResults = await analyzeGame(chess);
        
        // Clean up uploaded file
        fs.unlinkSync(req.file.path);
        
        res.json(analysisResults);
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Function to analyze a game with Stockfish
async function analyzeGame(chess) {
    return new Promise((resolve) => {
        const moves = chess.history();
        let analysisResults = [];

        function analyzeMove(index) {
            if (index >= moves.length) {
                return resolve(analysisResults);
            }

            const fen = chess.fen();
            engine.postMessage(`position fen ${fen}`);
            engine.postMessage('go depth 15');
            
            engine.onmessage = (message) => {
                if (message.includes("bestmove")) {
                    analysisResults.push({ move: moves[index], analysis: message });
                    chess.move(moves[index]);
                    analyzeMove(index + 1);
                }
            };
        }
        
        analyzeMove(0);
    });
}

// Generate PDF Report
app.get('/report/:id', (req, res) => {
    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="report.pdf"');
    
    doc.text('Chess Analysis Report', { align: 'center' });
    doc.moveDown();
    doc.text('Details of the game analysis will be here...');
    
    doc.pipe(res);
    doc.end();
});

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
