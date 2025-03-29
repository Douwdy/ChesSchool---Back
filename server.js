const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 5001;

// Activer CORS pour permettre les requêtes depuis le frontend
app.use(cors());

// Ouvrir la base de données SQLite
const db = new sqlite3.Database('./data/puzzles.db');

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

// Démarrer le serveur
app.listen(PORT, () => {
    console.log(`Serveur backend démarré sur http://localhost:${PORT}`);
});