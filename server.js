const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 5001;

// Configuration de CORS
const corsOptions = {
    origin: (origin, callback) => {
        // Liste blanche des domaines autorisés
        const whitelist = [
            'http://localhost:3000', // Frontend local
            'http://127.0.0.1:3000', // Frontend local (IPv4)
            'https://your-frontend-domain.com', // Frontend hébergé (à ajouter plus tard)
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